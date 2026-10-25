package tiacore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"time"
)

const (
	verificationDirectoryEnv = "TIA_VERIFICATION_DIRECTORY"
	verificationPhaseEnv     = "TIA_VERIFICATION_PHASE"
	verificationSchema       = 1
	adapterID                = "go-test"

	outcomePassed  = "passed"
	outcomeFailed  = "failed"
	outcomeUnknown = "unknown"
)

// verificationTarget is where `tiacore verify` collects this run's snapshot.
type verificationTarget struct {
	directory string
	phase     string
}

// readVerificationTarget reads the target from the process environment, not
// from Options.Environment, which belongs to the child. It returns nil when
// neither variable is set, and an error when only one is or the phase is
// neither selective nor full, so a misconfigured run fails before it plans.
func readVerificationTarget() (*verificationTarget, error) {
	directory, hasDirectory := os.LookupEnv(verificationDirectoryEnv)
	phase, hasPhase := os.LookupEnv(verificationPhaseEnv)
	if !hasDirectory && !hasPhase {
		return nil, nil
	}
	if !hasDirectory || !hasPhase {
		return nil, fmt.Errorf("%s and %s must be set together", verificationDirectoryEnv, verificationPhaseEnv)
	}
	if phase != "selective" && phase != "full" {
		return nil, fmt.Errorf("%s must be selective or full", verificationPhaseEnv)
	}
	return &verificationTarget{directory: directory, phase: phase}, nil
}

// verificationSnapshot is the file `tiacore verify` reads for one runner and phase.
type verificationSnapshot struct {
	ExecutedTestIDs []string          `json:"executedTestIds"`
	GeneratedAt     string            `json:"generatedAt"`
	Graph           Graph             `json:"graph"`
	Kind            string            `json:"kind"`
	Phase           string            `json:"phase"`
	Plan            Plan              `json:"plan"`
	Runner          string            `json:"runner"`
	Schema          int               `json:"schema"`
	Success         bool              `json:"success"`
	SuiteOutcomes   map[string]string `json:"suiteOutcomes"`
}

// verificationRun is one run that reports to a verification target.
type verificationRun struct {
	target   verificationTarget
	runner   string
	plan     Plan
	executed []string
	// packages maps each executed suite to the import path go test names it by.
	packages map[string]string
	results  *packageResults
}

func newVerificationRun(target verificationTarget, root, cachePath string, plan Plan, current catalog) *verificationRun {
	executed := []string{}
	if plan.Mode != "skip" {
		executed = sortedUnique(append(executed, plan.Selected...))
	}
	packages := make(map[string]string, len(executed))
	importPaths := make([]string, 0, len(executed))
	for _, id := range executed {
		packages[id] = current.SuitePackages[id]
		importPaths = append(importPaths, current.SuitePackages[id])
	}
	return &verificationRun{
		target:   target,
		runner:   verificationRunnerName(root, cachePath),
		plan:     plan,
		executed: executed,
		packages: packages,
		results:  newPackageResults(importPaths),
	}
}

// verificationRunnerName tells this runner's state file apart from the state
// file of any other lane of one command, and is the same in both phases.
func verificationRunnerName(root, cachePath string) string {
	relative, err := filepath.Rel(root, cachePath)
	if err != nil {
		relative = cachePath
	}
	return adapterID + ":" + filepath.ToSlash(relative)
}

// observe returns options whose output also feeds the package results. The
// output still goes where it went.
func (run *verificationRun) observe(options Options) Options {
	options.Stdout, options.Stderr = run.results.tee(options.Stdout, options.Stderr)
	return options
}

// outcomes says how each executed suite ended. A zero status passes them all.
// Otherwise a suite has the outcome go test reported for its package, and
// unknown when it reported none or contradicted itself: a suite is never
// passed merely because it was not mentioned. It first reads the last line of
// the output, which go test may have left without a newline.
func (run *verificationRun) outcomes(status int) map[string]string {
	if status != 0 {
		run.results.finish()
	}
	outcomes := make(map[string]string, len(run.executed))
	for _, id := range run.executed {
		if status == 0 {
			outcomes[id] = outcomePassed
		} else {
			outcomes[id] = run.results.outcome(run.packages[id])
		}
	}
	return outcomes
}

// write stores the snapshot of a finished run whose go test exited with status.
func (run *verificationRun) write(graph Graph, status int) error {
	snapshot := verificationSnapshot{
		ExecutedTestIDs: run.executed,
		GeneratedAt:     time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Graph:           graph,
		Kind:            "protocol",
		Phase:           run.target.phase,
		Plan:            run.plan,
		Runner:          run.runner,
		Schema:          verificationSchema,
		Success:         status == 0,
		SuiteOutcomes:   run.outcomes(status),
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte(run.runner))
	_, _ = digest.Write([]byte{0})
	_, _ = digest.Write([]byte(graph.Fingerprint))
	name := hex.EncodeToString(digest.Sum(nil)) + ".json"
	return writeAtomically(filepath.Join(run.target.directory, run.target.phase, name), func(file io.Writer) error {
		encoder := json.NewEncoder(file)
		encoder.SetEscapeHTML(false)
		return encoder.Encode(snapshot)
	})
}

// recordUnpromoted writes the snapshot of a run that promoted no graph: go test
// failed, or project files changed while it ran. The graph is the one a clean
// run would have promoted; it is incomplete when the project did not hold
// still, because it then describes files the tests did not all run against.
// A snapshot that cannot be written is reported and does not change the result.
func (run *verificationRun) recordUnpromoted(ctx context.Context, options Options, root, environmentFingerprint string, status int, projectHeldStill bool) {
	fresh, err := discover(ctx, options, root, environmentFingerprint)
	if err == nil {
		graph := fresh.Graph
		if !projectHeldStill {
			graph.Complete = false
		}
		err = run.write(graph, status)
	}
	if err != nil {
		fmt.Fprintf(options.Stderr, "tiacore-go: verification snapshot was not written: %v\n", err)
	}
}

// projectUnchanged reports whether the project still holds the files that were
// captured before go test ran. A project that cannot be captured is not known to.
func projectUnchanged(root string, before map[string]string) bool {
	after, err := captureSnapshot(root)
	return err == nil && reflect.DeepEqual(before, after)
}
