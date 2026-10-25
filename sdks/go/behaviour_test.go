package tiacore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
)

func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func rootPackageProject(t *testing.T) (string, Options) {
	t.Helper()
	t.Setenv("TIA_FRESH", "")
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		"go.mod":                   "module example.com/rootpkg\n\ngo 1.23\n",
		"root.go":                  "package rootpkg\n\nfunc Value() string { return \"root\" }\n",
		"root_test.go":             "package rootpkg\n\nimport \"testing\"\n\nfunc TestRoot(t *testing.T) { _ = Value() }\n",
		"inner/inner.go":           "package inner\n\nimport root \"example.com/rootpkg\"\n\nfunc Value() string { return root.Value() }\n",
		"inner/inner_test.go":      "package inner\n\nimport \"testing\"\n\nfunc TestInner(t *testing.T) { _ = Value() }\n",
		"standalone/standalone.go": "package standalone\n\nfunc Value() int { return 1 }\n",
	})
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	return root, Options{Root: root, CacheDirectory: ".tia/go", Stdout: stdout, Stderr: stderr}
}

func discoverFixture(t *testing.T, options Options, root string) catalog {
	t.Helper()
	resolved, err := resolveRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	if options.GoBinary == "" {
		options.GoBinary = "go"
	}
	found, err := discover(context.Background(), options, resolved, "env")
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestAGoPackageAtTheProjectRootBecomesASuiteAndIsSelected(t *testing.T) {
	root, options := rootPackageProject(t)
	found := discoverFixture(t, options, root)
	var ids []string
	for _, suite := range found.Graph.Suites {
		ids = append(ids, suite.ID)
	}
	want := []string{"go-package:example.com/rootpkg", "go-package:example.com/rootpkg/inner", "go-package:example.com/rootpkg/standalone"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("suites = %v, want %v", ids, want)
	}
	if file := found.Graph.Suites[0].File; file != "root_test.go" {
		t.Fatalf("root suite file = %q, want root_test.go", file)
	}

	if result := New(options).Run(context.Background()); !result.Success || result.Plan.Mode != "full" {
		t.Fatalf("baseline = %#v", result)
	}
	writeFiles(t, root, map[string]string{"root.go": "package rootpkg\n\nfunc Value() string { return \"changed\" }\n"})
	result := New(options).Run(context.Background())
	if !result.Success || result.Plan.Mode != "selective" {
		t.Fatalf("selective = %#v", result)
	}
	if want := []string{"example.com/rootpkg", "example.com/rootpkg/inner"}; !reflect.DeepEqual(result.Packages, want) {
		t.Fatalf("packages = %v, want %v", result.Packages, want)
	}
}

func TestDiscoveryRecordsSuitesTagsAndInferredObservations(t *testing.T) {
	root, options := rootPackageProject(t)
	found := discoverFixture(t, options, root)
	byID := map[string]Suite{}
	for _, suite := range found.Graph.Suites {
		byID[suite.ID] = suite
	}
	standalone := byID["go-package:example.com/rootpkg/standalone"]
	if standalone.File != "standalone/standalone.go" || !reflect.DeepEqual(standalone.Tags, []string{"go-package:example.com/rootpkg/standalone", "go-compile"}) {
		t.Fatalf("package without tests = %#v", standalone)
	}
	inner := byID["go-package:example.com/rootpkg/inner"]
	if inner.Adapter != "go-test" || inner.Project != "example.com/rootpkg" ||
		!reflect.DeepEqual(inner.Tags, []string{"go-package:example.com/rootpkg/inner", "go-tests"}) {
		t.Fatalf("package with tests = %#v", inner)
	}
	var sources []string
	for _, observation := range found.Graph.Observations {
		if observation.SuiteID != inner.ID {
			continue
		}
		sources = append(sources, observation.Source)
		wantKind := "import"
		if observation.Source == inner.File {
			wantKind = "configuration"
		}
		if observation.Kind != wantKind || observation.Confidence != "inferred" {
			t.Fatalf("observation = %#v", observation)
		}
	}
	wantSources := []string{"inner/inner.go", "inner/inner_test.go", "root.go", "root_test.go"}
	if !reflect.DeepEqual(sources, wantSources) {
		t.Fatalf("inner sources = %v, want %v", sources, wantSources)
	}
	if got := found.Graph.Invalidators; len(got) != 5 || got[0].Pattern != "go.mod" || got[4].Pattern != "vendor/**" {
		t.Fatalf("invalidators = %#v", got)
	}
	if _, err := ParseImpactGraph(mustJSON(t, found.Graph)); err != nil {
		t.Fatalf("generated graph is not protocol-valid: %v", err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestDiscoveryFailureRunsTheFullSuiteWithoutWritingState(t *testing.T) {
	root, options := rootPackageProject(t)
	options.PackagePatterns = []string{"./does-not-exist/..."}
	result := New(options).Run(context.Background())
	if result.Plan.Mode != "full" || result.Plan.Reason != "Go package discovery failed" {
		t.Fatalf("plan = %#v", result.Plan)
	}
	if !strings.Contains(options.Stderr.(*bytes.Buffer).String(), "tiacore-go: discovery failed; running the full Go suite") {
		t.Fatalf("stderr = %q", options.Stderr.(*bytes.Buffer).String())
	}
	if options.Stdout.(*bytes.Buffer).Len() != 0 && strings.Contains(options.Stdout.(*bytes.Buffer).String(), "tiacore-go:") {
		t.Fatalf("a plan line was printed: %q", options.Stdout.(*bytes.Buffer).String())
	}
	if _, err := os.Stat(filepath.Join(root, ".tia/go/state.json")); !os.IsNotExist(err) {
		t.Fatalf("state was written: %v", err)
	}
}

func TestEnvironmentFingerprintTracksInputsButNotShellBookkeeping(t *testing.T) {
	root, options := rootPackageProject(t)
	resolved, _ := resolveRoot(root)
	options.GoBinary = "go"
	fingerprint := func(mutate func(*Options)) string {
		copied := options
		copied.Environment = map[string]string{}
		mutate(&copied)
		value, err := goEnvironmentFingerprint(context.Background(), copied, resolved)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	base := fingerprint(func(*Options) {})
	for _, name := range []string{"TIA_FRESH", "PWD", "OLDPWD", "SHLVL", "_"} {
		if got := fingerprint(func(o *Options) { o.Environment[name] = "other-" + name }); got != base {
			t.Errorf("%s changed the fingerprint", name)
		}
	}
	for name, mutate := range map[string]func(*Options){
		"variable":  func(o *Options) { o.Environment["TIACORE_PROBE"] = "1" },
		"arguments": func(o *Options) { o.TestArguments = []string{"-run", "X"} },
		"suffix":    func(o *Options) { o.EnvironmentFingerprintSuffix = "lane-2" },
		"goflags":   func(o *Options) { o.Environment["GOFLAGS"] = "-count=1" },
	} {
		if got := fingerprint(mutate); got == base {
			t.Errorf("%s did not change the fingerprint", name)
		}
	}
}

func TestTIAFreshForcesAFullRunWhenItIsOneTrueYesOrOn(t *testing.T) {
	_, options := rootPackageProject(t)
	if result := New(options).Run(context.Background()); !result.Success {
		t.Fatal(result)
	}
	for _, value := range []string{"1", "true", "YES", "On"} {
		t.Setenv("TIA_FRESH", value)
		result := New(options).Run(context.Background())
		if result.Plan.Mode != "full" || result.Plan.Reason != "policy requires a full run" {
			t.Fatalf("TIA_FRESH=%s plan = %#v", value, result.Plan)
		}
	}
	for _, value := range []string{"0", "false", "no", "2", ""} {
		t.Setenv("TIA_FRESH", value)
		if result := New(options).Run(context.Background()); result.Plan.Mode != "skip" {
			t.Fatalf("TIA_FRESH=%q plan = %#v", value, result.Plan)
		}
	}
	t.Setenv("TIA_FRESH", "")
	options.Environment = map[string]string{"TIA_FRESH": "1"}
	if result := New(options).Run(context.Background()); result.Plan.Mode == "full" && result.Plan.Reason == "policy requires a full run" {
		t.Fatalf("Options.Environment must not force a full run: %#v", result.Plan)
	}
}

func TestAMissingGoBinaryAbortsInsteadOfFallingBack(t *testing.T) {
	_, options := rootPackageProject(t)
	options.GoBinary = "tiacore-definitely-not-a-go-binary"
	result := New(options).Run(context.Background())
	if result.Status != 1 || result.Success || result.Plan.Mode != "error" || len(result.Plan.Reasons) != 0 {
		t.Fatalf("result = %#v", result)
	}
	if !strings.Contains(options.Stderr.(*bytes.Buffer).String(), "tiacore-go: read Go environment") {
		t.Fatalf("stderr = %q", options.Stderr.(*bytes.Buffer).String())
	}
}

func TestStateIsAtomicIndentedAndVersioned(t *testing.T) {
	root, options := rootPackageProject(t)
	if result := New(options).Run(context.Background()); !result.Success {
		t.Fatal(result)
	}
	path := filepath.Join(root, ".tia/go/state.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(data), "{\n  \"stateVersion\": 1,\n  \"graph\": {") || !strings.HasSuffix(string(data), "}\n") {
		t.Fatalf("state format:\n%s", data[:min(len(data), 120)])
	}
	var parsed struct {
		Snapshot map[string]string `json:"snapshot"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if _, ok := parsed.Snapshot["root.go"]; !ok || len(parsed.Snapshot["root.go"]) != 64 {
		t.Fatalf("snapshot = %v", parsed.Snapshot)
	}
	for name := range parsed.Snapshot {
		if strings.HasPrefix(name, ".tia/") {
			t.Fatalf("snapshot includes %s", name)
		}
	}
	leftovers, _ := filepath.Glob(filepath.Join(root, ".tia/go/*.tmp"))
	if len(leftovers) != 0 {
		t.Fatalf("temporary files left: %v", leftovers)
	}
}

func TestIncompatibleStateIsIgnoredWithAMessage(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"state version":    func(state map[string]any) { state["stateVersion"] = 2 },
		"unknown field":    func(state map[string]any) { state["extra"] = true },
		"incomplete graph": func(state map[string]any) { state["graph"].(map[string]any)["complete"] = false },
		"graph version":    func(state map[string]any) { state["graph"].(map[string]any)["protocolVersion"] = 2 },
		"missing snapshot": func(state map[string]any) { delete(state, "snapshot") },
	} {
		t.Run(name, func(t *testing.T) {
			root, options := rootPackageProject(t)
			if result := New(options).Run(context.Background()); !result.Success {
				t.Fatal(result)
			}
			path := filepath.Join(root, ".tia/go/state.json")
			data, _ := os.ReadFile(path)
			var state map[string]any
			if err := json.Unmarshal(data, &state); err != nil {
				t.Fatal(err)
			}
			mutate(state)
			if err := os.WriteFile(path, mustJSON(t, state), 0o644); err != nil {
				t.Fatal(err)
			}
			options.Stderr.(*bytes.Buffer).Reset()
			result := New(options).Run(context.Background())
			if result.Plan.Mode != "full" || result.Plan.Reason != "no compatible impact graph found" {
				t.Fatalf("plan = %#v", result.Plan)
			}
			if !strings.Contains(options.Stderr.(*bytes.Buffer).String(), "tiacore-go: ignoring incompatible state") {
				t.Fatalf("stderr = %q", options.Stderr.(*bytes.Buffer).String())
			}
		})
	}
}

func TestCacheDirectoryContainment(t *testing.T) {
	_, options := rootPackageProject(t)
	options.CacheDirectory = "../escape"
	result := New(options).Run(context.Background())
	if result.Status != 1 || result.Plan.Mode != "error" || !strings.Contains(result.Plan.Reason, "cache directory escapes project: ../escape") {
		t.Fatalf("result = %#v", result)
	}
	root, options := rootPackageProject(t)
	options.CacheDirectory = filepath.Join(t.TempDir(), "elsewhere")
	if result := New(options).Run(context.Background()); !result.Success {
		t.Fatal(result)
	}
	if _, err := os.Stat(filepath.Join(options.CacheDirectory, "state.json")); err != nil {
		t.Fatalf("absolute cache directory was not used: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".tia")); !os.IsNotExist(err) {
		t.Fatal("project-relative cache was created")
	}
}

func TestSnapshotUsesGitAndSkipsExcludedDirectories(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is unavailable")
	}
	root, _ := rootPackageProject(t)
	resolved, _ := resolveRoot(root)
	writeFiles(t, resolved, map[string]string{
		".gitignore":            "ignored.txt\n",
		"ignored.txt":           "ignored",
		"notes.txt":             "kept",
		"node_modules/dep/x.js": "x",
		"build/out.bin":         "x",
		"dist/out.bin":          "x",
		"coverage/lcov.info":    "x",
		".worktrees/other/file": "x",
		".tia/go/state.json":    "{}",
		"build.go.txt":          "not a build directory",
	})
	for _, args := range [][]string{{"init", "-q"}, {"add", "-A"}} {
		command := exec.Command("git", args...)
		command.Dir = resolved
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, output)
		}
	}
	if err := os.Symlink("root.go", filepath.Join(resolved, "link.go")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	snapshot, err := captureSnapshot(resolved)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for name := range snapshot {
		names = append(names, name)
	}
	sort.Strings(names)
	want := []string{".gitignore", "build.go.txt", "go.mod", "inner/inner.go", "inner/inner_test.go", "link.go", "notes.txt", "root.go", "root_test.go", "standalone/standalone.go"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("snapshot = %v, want %v", names, want)
	}
	sum := sha256.Sum256([]byte("symlink:root.go"))
	if snapshot["link.go"] != hex.EncodeToString(sum[:]) {
		t.Fatalf("symlink digest = %s", snapshot["link.go"])
	}
}

func TestChangedFilesIsTheSortedSymmetricDifference(t *testing.T) {
	previous := map[string]string{"a": "1", "b": "1", "c": "1"}
	current := map[string]string{"b": "2", "c": "1", "d": "1"}
	if got, want := changedFiles(previous, current), []string{"a", "b", "d"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("changed = %v, want %v", got, want)
	}
}

func TestNonGoChangesForceAFullRun(t *testing.T) {
	root, options := rootPackageProject(t)
	if result := New(options).Run(context.Background()); !result.Success {
		t.Fatal(result)
	}
	writeFiles(t, root, map[string]string{".github/ci.yml": "name: ci\n"})
	result := New(options).Run(context.Background())
	if result.Plan.Mode != "full" || result.Plan.Reason != "changed file is unknown to the impact graph: .github/ci.yml" {
		t.Fatalf("plan = %#v", result.Plan)
	}
}

func TestPlanLinesAndJSONPlan(t *testing.T) {
	_, options := rootPackageProject(t)
	New(options).Run(context.Background())
	stdout := options.Stdout.(*bytes.Buffer).String()
	if !strings.HasPrefix(stdout, "tiacore-go: full: no compatible impact graph found (1 Go packages)\n") {
		t.Fatalf("stdout = %q", stdout)
	}

	options.Stdout.(*bytes.Buffer).Reset()
	options.JSONPlan = true
	result := New(options).Run(context.Background())
	line := strings.SplitN(options.Stdout.(*bytes.Buffer).String(), "\n", 2)[0]
	var printed struct {
		Plan     Plan     `json:"plan"`
		Packages []string `json:"packages"`
	}
	if err := json.Unmarshal([]byte(line), &printed); err != nil {
		t.Fatalf("%q: %v", line, err)
	}
	if printed.Plan.Mode != "skip" || len(printed.Packages) != 0 || !result.Success {
		t.Fatalf("printed = %#v", printed)
	}
}

func TestFailedRunKeepsTheStateFileUntouched(t *testing.T) {
	root, options := rootPackageProject(t)
	if result := New(options).Run(context.Background()); !result.Success {
		t.Fatal(result)
	}
	path := filepath.Join(root, ".tia/go/state.json")
	before, _ := os.ReadFile(path)
	writeFiles(t, root, map[string]string{"root_test.go": "package rootpkg\n\nimport \"testing\"\n\nfunc TestRoot(t *testing.T) { t.Fatal(\"boom\") }\n"})
	result := New(options).Run(context.Background())
	if result.Success || result.Status == 0 {
		t.Fatalf("result = %#v", result)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("a failing run rewrote the state")
	}
}

func TestChangesDuringGoTestAreNotPromoted(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs a shell wrapper")
	}
	root, options := rootPackageProject(t)
	realGo, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	wrapper := filepath.Join(t.TempDir(), "go-wrapper")
	script := "#!/bin/sh\nif [ \"$1\" = test ]; then echo changed > \"" + root + "/touched-during-test.txt\"; fi\nexec \"" + realGo + "\" \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	options.GoBinary = wrapper
	result := New(options).Run(context.Background())
	if !result.Success {
		t.Fatalf("result = %#v", result)
	}
	if !strings.Contains(options.Stderr.(*bytes.Buffer).String(), "tiacore-go: project files changed during go test; successful results were not promoted") {
		t.Fatalf("stderr = %q", options.Stderr.(*bytes.Buffer).String())
	}
	if _, err := os.Stat(filepath.Join(root, ".tia/go/state.json")); !os.IsNotExist(err) {
		t.Fatalf("state was promoted: %v", err)
	}
}

func TestSelectivePackageArgumentsAreSortedUniqueImportPaths(t *testing.T) {
	plan := Plan{Mode: "selective", Selected: []string{"go-package:b", "go-package:a"}}
	current := catalog{SuitePackages: map[string]string{"go-package:a": "a", "go-package:b": "b"}}
	if got := selectedPackages(plan, current, Options{PackagePatterns: []string{"./x/..."}}); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("selective = %v", got)
	}
	if got := selectedPackages(Plan{Mode: "full"}, current, Options{PackagePatterns: []string{"./x/...", "./y"}}); !reflect.DeepEqual(got, []string{"./x/...", "./y"}) {
		t.Fatalf("full = %v", got)
	}
	if got := selectedPackages(Plan{Mode: "full"}, current, Options{}); !reflect.DeepEqual(got, []string{"./..."}) {
		t.Fatalf("default = %v", got)
	}
}

func buildCLI(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "tiacore-go")
	if output, err := exec.Command("go", "build", "-o", binary, "./cmd/tiacore-go").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	return binary
}

func TestCommandLineFlagsTrailingArgumentsAndExitCodes(t *testing.T) {
	binary := buildCLI(t)
	root, _ := rootPackageProject(t)
	environment := append(os.Environ(), "TIA_FRESH=")

	run := func(arguments ...string) (string, string, int) {
		command := exec.Command(binary, arguments...)
		command.Env = environment
		var stdout, stderr bytes.Buffer
		command.Stdout, command.Stderr = &stdout, &stderr
		err := command.Run()
		code := 0
		if exitError, ok := err.(*exec.ExitError); ok {
			code = exitError.ExitCode()
		}
		return stdout.String(), stderr.String(), code
	}

	stdout, _, code := run("-root", root, "-json", "-packages", "./inner", "-packages", "./standalone", "--", "-count=1")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stdout)
	}
	var printed struct {
		Plan     Plan     `json:"plan"`
		Packages []string `json:"packages"`
	}
	if err := json.Unmarshal([]byte(strings.SplitN(stdout, "\n", 2)[0]), &printed); err != nil {
		t.Fatalf("%q: %v", stdout, err)
	}
	if printed.Plan.Mode != "full" || !reflect.DeepEqual(printed.Packages, []string{"./inner", "./standalone"}) {
		t.Fatalf("printed = %#v", printed)
	}
	if _, err := os.Stat(filepath.Join(root, ".tia/go/state.json")); err != nil {
		t.Fatal(err)
	}

	stdout, _, code = run("-root", root, "-packages", "./inner", "-packages", "./standalone", "-cache-dir", ".tia/go", "-go", "go", "-project", "demo", "-force", "--", "-count=1")
	if code != 0 || !strings.HasPrefix(stdout, "tiacore-go: full: policy requires a full run (2 Go packages)\n") {
		t.Fatalf("exit %d stdout %q", code, stdout)
	}

	_, stderr, code := run("-no-such-flag")
	if code != 2 || !strings.Contains(stderr, "usage: tiacore-go [adapter flags] [-- go-test-flags]") {
		t.Fatalf("exit %d stderr %q", code, stderr)
	}

	writeFiles(t, root, map[string]string{"root_test.go": "package rootpkg\n\nimport \"testing\"\n\nfunc TestRoot(t *testing.T) { t.Fatal(\"boom\") }\n"})
	_, _, code = run("-root", root, "-packages", "./...")
	if code == 0 {
		t.Fatal("the failing go test did not set the exit code")
	}
}

func TestReceiptSourceRevisionMatchesTheSDKSources(t *testing.T) {
	repository, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	files := []string{filepath.Join(repository, "go.mod")}
	err = filepath.WalkDir(filepath.Join(repository, "sdks", "go"), func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if entry.Name() == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	digest := sha256.New()
	for _, file := range files {
		relative, _ := filepath.Rel(repository, file)
		content, readErr := os.ReadFile(file)
		if readErr != nil {
			t.Fatal(readErr)
		}
		digest.Write([]byte(filepath.ToSlash(relative)))
		digest.Write([]byte{0})
		digest.Write(content)
		digest.Write([]byte{0})
	}
	data, err := os.ReadFile("certification/adapter.json")
	if err != nil {
		t.Fatal(err)
	}
	var receipt struct {
		SourceRevision string `json:"sourceRevision"`
	}
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	if want := "sha256:" + hex.EncodeToString(digest.Sum(nil)); receipt.SourceRevision != want {
		t.Fatalf("sourceRevision = %s, want %s", receipt.SourceRevision, want)
	}
}
