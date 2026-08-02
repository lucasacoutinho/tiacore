package tiacore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

func (runner *Runner) run(ctx context.Context) Result {
	options := runner.options
	if options.Root == "" {
		options.Root = "."
	}
	root, err := filepath.Abs(options.Root)
	if err != nil {
		return failedResult(options, fmt.Errorf("resolve project root: %w", err))
	}
	if options.GoBinary == "" {
		options.GoBinary = "go"
	}
	if options.Stdout == nil {
		options.Stdout = os.Stdout
	}
	if options.Stderr == nil {
		options.Stderr = os.Stderr
	}
	cachePath, err := statePath(root, options.CacheDirectory)
	if err != nil {
		return failedResult(options, err)
	}
	environmentFingerprint, err := goEnvironmentFingerprint(ctx, options, root)
	if err != nil {
		return failedResult(options, err)
	}
	currentSnapshot, err := captureSnapshot(root)
	if err != nil {
		return failedResult(options, fmt.Errorf("capture project snapshot: %w", err))
	}
	currentCatalog, err := discover(ctx, options, root, environmentFingerprint)
	if err != nil {
		fmt.Fprintf(options.Stderr, "tiacore-go: discovery failed; running the full Go suite: %v\n", err)
		status := runGoTest(ctx, options, root, fullPackageArguments(options))
		return Result{Plan: fullPlan(nil, nil, "Go package discovery failed"), Status: status, Success: status == 0}
	}

	previous, stateErr := readState(cachePath)
	var previousGraph *Graph
	changes := []string(nil)
	if stateErr == nil && previous != nil {
		previousGraph = &previous.Graph
		changes = changedFiles(previous.Snapshot, currentSnapshot)
	} else if stateErr != nil {
		fmt.Fprintf(options.Stderr, "tiacore-go: ignoring incompatible state: %v\n", stateErr)
	}
	force := options.ForceFull || os.Getenv("TIA_FRESH") == "1"
	plan := createPlan(currentCatalog.Graph, previousGraph, changes, force)
	packages := selectedPackages(plan, currentCatalog, options)
	writePlan(options, plan, packages)

	status := 0
	if plan.Mode != "skip" {
		status = runGoTest(ctx, options, root, packages)
	}
	if status != 0 {
		return Result{Plan: plan, Packages: packages, Status: status, Success: false}
	}
	if plan.Mode != "skip" {
		freshSnapshot, snapshotErr := captureSnapshot(root)
		if snapshotErr != nil {
			return failedResult(options, fmt.Errorf("capture successful project snapshot: %w", snapshotErr))
		}
		if !reflect.DeepEqual(currentSnapshot, freshSnapshot) {
			fmt.Fprintln(options.Stderr, "tiacore-go: project files changed during go test; successful results were not promoted")
			return Result{Plan: plan, Packages: packages, Status: 0, Success: true}
		}
		freshCatalog, discoverErr := discover(ctx, options, root, environmentFingerprint)
		if discoverErr != nil {
			return failedResult(options, fmt.Errorf("refresh successful Go graph: %w", discoverErr))
		}
		if writeErr := writeState(cachePath, state{StateVersion: stateVersion, Graph: freshCatalog.Graph, Snapshot: freshSnapshot}); writeErr != nil {
			return failedResult(options, fmt.Errorf("promote Go impact state: %w", writeErr))
		}
	}
	return Result{Plan: plan, Packages: packages, Status: 0, Success: true}
}

func goEnvironmentFingerprint(ctx context.Context, options Options, root string) (string, error) {
	command := exec.CommandContext(ctx, options.GoBinary, "env", "-json", "GOOS", "GOARCH", "CGO_ENABLED", "GOVERSION", "GOFLAGS", "GOWORK")
	command.Dir = root
	command.Env = commandEnvironment(options.Environment)
	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("read Go environment: %w", err)
	}
	hash := sha256.New()
	_, _ = hash.Write(output)
	environment := commandEnvironment(options.Environment)
	sort.Strings(environment)
	for _, value := range environment {
		name, _, _ := strings.Cut(value, "=")
		if name == "TIA_FRESH" || name == "PWD" || name == "OLDPWD" || name == "SHLVL" || name == "_" {
			continue
		}
		_, _ = hash.Write([]byte(value))
		_, _ = hash.Write([]byte{0})
	}
	encoded, _ := json.Marshal(options.TestArguments)
	_, _ = hash.Write(encoded)
	_, _ = hash.Write([]byte(options.EnvironmentFingerprintSuffix))
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func selectedPackages(plan Plan, current catalog, options Options) []string {
	if plan.Mode == "full" {
		return fullPackageArguments(options)
	}
	packages := make([]string, 0, len(plan.Selected))
	seen := make(map[string]struct{})
	for _, suiteID := range plan.Selected {
		packageName := current.SuitePackages[suiteID]
		if packageName == "" {
			continue
		}
		if _, exists := seen[packageName]; !exists {
			seen[packageName] = struct{}{}
			packages = append(packages, packageName)
		}
	}
	sort.Strings(packages)
	return packages
}

func fullPackageArguments(options Options) []string {
	if len(options.PackagePatterns) == 0 {
		return []string{"./..."}
	}
	return append([]string{}, options.PackagePatterns...)
}

func runGoTest(ctx context.Context, options Options, root string, packages []string) int {
	arguments := append([]string{"test"}, options.TestArguments...)
	arguments = append(arguments, packages...)
	command := exec.CommandContext(ctx, options.GoBinary, arguments...)
	command.Dir = root
	command.Env = commandEnvironment(options.Environment)
	command.Stdout = options.Stdout
	command.Stderr = options.Stderr
	if err := command.Run(); err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			return exitError.ExitCode()
		}
		fmt.Fprintf(options.Stderr, "tiacore-go: execute go test: %v\n", err)
		return 1
	}
	return 0
}

func writePlan(options Options, plan Plan, packages []string) {
	if options.JSONPlan {
		encoded, err := json.Marshal(struct {
			Plan     Plan     `json:"plan"`
			Packages []string `json:"packages"`
		}{Plan: plan, Packages: packages})
		if err == nil {
			fmt.Fprintln(options.Stdout, string(encoded))
		}
		return
	}
	fmt.Fprintf(options.Stdout, "tiacore-go: %s: %s", plan.Mode, plan.Reason)
	if len(packages) > 0 {
		fmt.Fprintf(options.Stdout, " (%d Go packages)", len(packages))
	}
	fmt.Fprintln(options.Stdout)
}

func failedResult(options Options, err error) Result {
	stderr := options.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	fmt.Fprintln(stderr, "tiacore-go:", err)
	return Result{Plan: Plan{Mode: "error", Protocol: ProtocolVersion, Reason: err.Error(), Reasons: map[string][]string{}}, Status: 1, Success: false}
}
