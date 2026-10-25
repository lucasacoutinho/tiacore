package tiacore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	rootSuite       = "go-package:example.com/rootpkg"
	innerSuite      = "go-package:example.com/rootpkg/inner"
	standaloneSuite = "go-package:example.com/rootpkg/standalone"

	failingInnerTest = "package inner\n\nimport \"testing\"\n\nfunc TestInner(t *testing.T) { t.Fatal(\"boom\") }\n"
	brokenInnerTest  = "package inner\n\nimport \"testing\"\n\nfunc TestInner(t *testing.T) { _ = undefinedThing }\n"
)

// withoutVerificationTarget leaves neither verification variable set for the test.
func withoutVerificationTarget(t *testing.T) {
	t.Helper()
	for _, name := range []string{verificationDirectoryEnv, verificationPhaseEnv} {
		t.Setenv(name, "")
		if err := os.Unsetenv(name); err != nil {
			t.Fatal(err)
		}
	}
}

func verificationTargetIs(t *testing.T, directory, phase string) {
	t.Helper()
	t.Setenv(verificationDirectoryEnv, directory)
	t.Setenv(verificationPhaseEnv, phase)
}

// verifiedProject is rootPackageProject with a passing test in every package.
func verifiedProject(t *testing.T) (string, Options) {
	t.Helper()
	withoutVerificationTarget(t)
	root, options := rootPackageProject(t)
	writeFiles(t, root, map[string]string{
		"standalone/standalone_test.go": "package standalone\n\nimport \"testing\"\n\nfunc TestStandalone(t *testing.T) { _ = Value() }\n",
	})
	return root, options
}

func snapshotNames(t *testing.T, directory, phase string) []string {
	t.Helper()
	names, err := filepath.Glob(filepath.Join(directory, phase, "*"))
	if err != nil {
		t.Fatal(err)
	}
	for index, name := range names {
		names[index] = filepath.Base(name)
	}
	sort.Strings(names)
	return names
}

// readSnapshot decodes the one snapshot file of a phase and returns it with its name.
func readSnapshot(t *testing.T, directory, phase string) (map[string]any, string) {
	t.Helper()
	names := snapshotNames(t, directory, phase)
	if len(names) != 1 || !strings.HasSuffix(names[0], ".json") {
		t.Fatalf("%s snapshot files = %v, want exactly one .json file", phase, names)
	}
	data, err := os.ReadFile(filepath.Join(directory, phase, names[0]))
	if err != nil {
		t.Fatal(err)
	}
	var snapshot map[string]any
	if err := json.Unmarshal(data, &snapshot); err != nil {
		t.Fatalf("%s: %v", data, err)
	}
	return snapshot, names[0]
}

func decoded(t *testing.T, value any) any {
	t.Helper()
	var result any
	if err := json.Unmarshal(mustJSON(t, value), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func readStateGraph(t *testing.T, root string) any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, ".tia/go/state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		Graph any `json:"graph"`
	}
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	return stored.Graph
}

func outcomesOf(t *testing.T, snapshot map[string]any) map[string]string {
	t.Helper()
	raw, ok := snapshot["suiteOutcomes"].(map[string]any)
	if !ok {
		t.Fatalf("suiteOutcomes = %#v", snapshot["suiteOutcomes"])
	}
	outcomes := make(map[string]string, len(raw))
	for id, value := range raw {
		outcomes[id] = value.(string)
	}
	return outcomes
}

func executedOf(t *testing.T, snapshot map[string]any) []string {
	t.Helper()
	raw, ok := snapshot["executedTestIds"].([]any)
	if !ok {
		t.Fatalf("executedTestIds = %#v", snapshot["executedTestIds"])
	}
	executed := make([]string, len(raw))
	for index, value := range raw {
		executed[index] = value.(string)
	}
	return executed
}

func graphIsComplete(t *testing.T, snapshot map[string]any) bool {
	t.Helper()
	return snapshot["graph"].(map[string]any)["complete"].(bool)
}

// fakeGo is a go command that answers `go test` with the given output and exit
// status and hands every other subcommand to the real go.
func fakeGo(t *testing.T, stdout, stderr string, status int) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs a shell wrapper")
	}
	realGo, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "stdout.txt"), []byte(stdout), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "stderr.txt"), []byte(stderr), 0o644); err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf("#!/bin/sh\nif [ \"$1\" = test ]; then cat '%s/stdout.txt'; cat '%s/stderr.txt' >&2; exit %d; fi\nexec '%s' \"$@\"\n",
		directory, directory, status, realGo)
	wrapper := filepath.Join(directory, "go")
	if err := os.WriteFile(wrapper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return wrapper
}

// touchingGo is the real go, except that `go test` first writes a file into root.
func touchingGo(t *testing.T, root string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs a shell wrapper")
	}
	realGo, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	wrapper := filepath.Join(t.TempDir(), "go")
	script := "#!/bin/sh\nif [ \"$1\" = test ]; then echo changed > '" + root + "/touched-during-test.txt'; fi\nexec '" + realGo + "' \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return wrapper
}

func TestWithoutAVerificationTargetNoSnapshotIsWritten(t *testing.T) {
	root, options := verifiedProject(t)
	for _, want := range []string{"full", "skip"} {
		if result := New(options).Run(context.Background()); !result.Success || result.Plan.Mode != want {
			t.Fatalf("%s run = %#v", want, result)
		}
	}
	var files []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr == nil && !entry.IsDir() && strings.HasSuffix(path, ".json") {
			files = append(files, path)
		}
		return walkErr
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{filepath.Join(root, ".tia/go/state.json")}; !reflect.DeepEqual(files, want) {
		t.Fatalf("json files = %v, want only the state", files)
	}
}

func TestATargetDoesNotChangeTheOutputOrTheResultOfARun(t *testing.T) {
	const output = "ok  \texample.com/rootpkg\t0.003s\nFAIL\texample.com/rootpkg/inner\t0.002s\nFAIL"
	run := func(withTarget bool) (Result, string, string) {
		_, options := verifiedProject(t)
		options.GoBinary = fakeGo(t, output, "stderr text\n", 1)
		if withTarget {
			verificationTargetIs(t, t.TempDir(), "full")
		}
		result := New(options).Run(context.Background())
		return result, options.Stdout.(*bytes.Buffer).String(), options.Stderr.(*bytes.Buffer).String()
	}
	plain, plainOut, plainErr := run(false)
	observed, observedOut, observedErr := run(true)
	if !reflect.DeepEqual(plain, observed) || plainOut != observedOut || plainErr != observedErr {
		t.Fatalf("a target changed the run:\nresult %#v\nstdout %q\nstderr %q\nvs\nresult %#v\nstdout %q\nstderr %q",
			plain, plainOut, plainErr, observed, observedOut, observedErr)
	}
	if !strings.HasSuffix(observedOut, output) || !strings.HasSuffix(observedErr, "stderr text\n") {
		t.Fatalf("go test output was not forwarded unchanged: %q / %q", observedOut, observedErr)
	}
}

func TestSelectiveAndFullPhasesWriteTheirSnapshots(t *testing.T) {
	root, options := verifiedProject(t)
	if result := New(options).Run(context.Background()); !result.Success {
		t.Fatalf("baseline = %#v", result)
	}
	writeFiles(t, root, map[string]string{"root.go": "package rootpkg\n\nfunc Value() string { return \"changed\" }\n"})

	directory := t.TempDir()
	verificationTargetIs(t, directory, "selective")
	selective := New(options).Run(context.Background())
	if !selective.Success || selective.Plan.Mode != "selective" {
		t.Fatalf("a baseline recorded outside a verification must still select: %#v", selective)
	}
	snapshot, name := readSnapshot(t, directory, "selective")
	wantKeys := []string{"executedTestIds", "generatedAt", "graph", "kind", "phase", "plan", "runner", "schema", "success", "suiteOutcomes"}
	var keys []string
	for key := range snapshot {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if !reflect.DeepEqual(keys, wantKeys) {
		t.Fatalf("keys = %v, want %v", keys, wantKeys)
	}
	const runner = "go-test:.tia/go/state.json"
	graph := snapshot["graph"].(map[string]any)
	digest := sha256.Sum256([]byte(runner + "\x00" + graph["fingerprint"].(string)))
	if want := hex.EncodeToString(digest[:]) + ".json"; name != want {
		t.Fatalf("file name = %s, want %s", name, want)
	}
	if snapshot["kind"] != "protocol" || snapshot["schema"] != float64(1) || snapshot["phase"] != "selective" ||
		snapshot["runner"] != runner || snapshot["success"] != true {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", snapshot["generatedAt"].(string)); err != nil {
		t.Fatalf("generatedAt: %v", err)
	}
	wantExecuted := []string{rootSuite, innerSuite}
	if !reflect.DeepEqual(executedOf(t, snapshot), wantExecuted) || !reflect.DeepEqual(selective.Plan.Selected, wantExecuted) {
		t.Fatalf("executed = %v, selected = %v, want %v", executedOf(t, snapshot), selective.Plan.Selected, wantExecuted)
	}
	if want := map[string]string{rootSuite: "passed", innerSuite: "passed"}; !reflect.DeepEqual(outcomesOf(t, snapshot), want) {
		t.Fatalf("outcomes = %v, want %v", outcomesOf(t, snapshot), want)
	}
	if !reflect.DeepEqual(snapshot["plan"], decoded(t, selective.Plan)) {
		t.Fatalf("plan = %#v, want %#v", snapshot["plan"], decoded(t, selective.Plan))
	}
	if !reflect.DeepEqual(snapshot["graph"], readStateGraph(t, root)) {
		t.Fatal("the snapshot's graph is not the graph the run promoted")
	}
	if leftovers, _ := filepath.Glob(filepath.Join(directory, "selective", "*.tmp")); len(leftovers) != 0 {
		t.Fatalf("temporary files left: %v", leftovers)
	}

	verificationTargetIs(t, directory, "full")
	t.Setenv("TIA_FRESH", "1")
	full := New(options).Run(context.Background())
	if !full.Success || full.Plan.Mode != "full" {
		t.Fatalf("full = %#v", full)
	}
	fullSnapshot, fullName := readSnapshot(t, directory, "full")
	if fullName != name || fullSnapshot["phase"] != "full" {
		t.Fatalf("full snapshot %s %v, want the selective file name %s", fullName, fullSnapshot["phase"], name)
	}
	wantAll := []string{rootSuite, innerSuite, standaloneSuite}
	if !reflect.DeepEqual(executedOf(t, fullSnapshot), wantAll) {
		t.Fatalf("full executed = %v, want %v", executedOf(t, fullSnapshot), wantAll)
	}
	for id, outcome := range outcomesOf(t, fullSnapshot) {
		if outcome != "passed" {
			t.Fatalf("%s = %s", id, outcome)
		}
	}
	if len(outcomesOf(t, fullSnapshot)) != 3 {
		t.Fatalf("outcomes = %v", outcomesOf(t, fullSnapshot))
	}
	if !reflect.DeepEqual(fullSnapshot["graph"], readStateGraph(t, root)) {
		t.Fatal("the full snapshot's graph is not the graph the run promoted")
	}
}

func TestASkipPlanWritesAnEmptySnapshotWithItsGraph(t *testing.T) {
	root, options := verifiedProject(t)
	if result := New(options).Run(context.Background()); !result.Success {
		t.Fatal(result)
	}
	directory := t.TempDir()
	verificationTargetIs(t, directory, "selective")
	result := New(options).Run(context.Background())
	if !result.Success || result.Plan.Mode != "skip" {
		t.Fatalf("result = %#v", result)
	}
	snapshot, _ := readSnapshot(t, directory, "selective")
	if executed, ok := snapshot["executedTestIds"].([]any); !ok || len(executed) != 0 {
		t.Fatalf("executedTestIds = %#v, want []", snapshot["executedTestIds"])
	}
	if outcomes, ok := snapshot["suiteOutcomes"].(map[string]any); !ok || len(outcomes) != 0 {
		t.Fatalf("suiteOutcomes = %#v, want {}", snapshot["suiteOutcomes"])
	}
	if snapshot["success"] != true || snapshot["plan"].(map[string]any)["mode"] != "skip" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if !reflect.DeepEqual(snapshot["graph"], readStateGraph(t, root)) || !graphIsComplete(t, snapshot) {
		t.Fatal("a skip snapshot must carry the complete graph of the project")
	}
}

func TestAMisconfiguredTargetFailsBeforeAnythingRuns(t *testing.T) {
	for name, test := range map[string]struct {
		directory, phase *string
		message          string
	}{
		"directory without phase": {directory: ptr(t.TempDir()), message: "TIA_VERIFICATION_DIRECTORY and TIA_VERIFICATION_PHASE must be set together"},
		"phase without directory": {phase: ptr("full"), message: "TIA_VERIFICATION_DIRECTORY and TIA_VERIFICATION_PHASE must be set together"},
		"unknown phase":           {directory: ptr(t.TempDir()), phase: ptr("weekly"), message: "TIA_VERIFICATION_PHASE must be selective or full"},
		"empty phase":             {directory: ptr(t.TempDir()), phase: ptr(""), message: "TIA_VERIFICATION_PHASE must be selective or full"},
	} {
		t.Run(name, func(t *testing.T) {
			root, options := verifiedProject(t)
			marker := filepath.Join(t.TempDir(), "go-was-run")
			options.GoBinary = writeScript(t, "#!/bin/sh\ntouch '"+marker+"'\nexit 0\n")
			if test.directory != nil {
				t.Setenv(verificationDirectoryEnv, *test.directory)
			}
			if test.phase != nil {
				t.Setenv(verificationPhaseEnv, *test.phase)
			}
			result := New(options).Run(context.Background())
			if result.Status != 1 || result.Success || result.Plan.Mode != "error" || result.Plan.Reason != test.message {
				t.Fatalf("result = %#v", result)
			}
			if got := options.Stderr.(*bytes.Buffer).String(); got != "tiacore-go: "+test.message+"\n" {
				t.Fatalf("stderr = %q", got)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("go was run")
			}
			if _, err := os.Stat(filepath.Join(root, ".tia")); !os.IsNotExist(err) {
				t.Fatal("state was written")
			}
		})
	}
}

func ptr(value string) *string { return &value }

func writeScript(t *testing.T, script string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs a shell wrapper")
	}
	path := filepath.Join(t.TempDir(), "go")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestTheTargetOnlyReadsTheProcessEnvironment(t *testing.T) {
	_, options := verifiedProject(t)
	options.Environment = map[string]string{verificationDirectoryEnv: t.TempDir(), verificationPhaseEnv: "full"}
	if result := New(options).Run(context.Background()); !result.Success {
		t.Fatal(result)
	}
	if names := snapshotNames(t, options.Environment[verificationDirectoryEnv], "full"); len(names) != 0 {
		t.Fatalf("Options.Environment configured a verification target: %v", names)
	}
}

func TestEnvironmentFingerprintIgnoresTheVerificationTarget(t *testing.T) {
	root, options := verifiedProject(t)
	resolved, _ := resolveRoot(root)
	options.GoBinary = "go"
	fingerprint := func() string {
		value, err := goEnvironmentFingerprint(context.Background(), options, resolved)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	base := fingerprint()
	verificationTargetIs(t, t.TempDir(), "selective")
	if got := fingerprint(); got != base {
		t.Fatal("the verification target changed the fingerprint, so a verification could never select")
	}
	verificationTargetIs(t, t.TempDir(), "full")
	if got := fingerprint(); got != base {
		t.Fatal("the verification target changed the fingerprint, so a verification could never select")
	}
}

func TestAFailingRunAttributesTheOutcomeOfEachPackageItReports(t *testing.T) {
	for name, test := range map[string]struct {
		arguments []string
		broken    string
		forwarded string
		inner     string
	}{
		"plain":              {inner: "failed", broken: failingInnerTest, forwarded: "FAIL\texample.com/rootpkg/inner\t"},
		"json":               {arguments: []string{"-json"}, inner: "failed", broken: failingInnerTest, forwarded: `"Action":"fail","Package":"example.com/rootpkg/inner"`},
		"build failure":      {inner: "failed", broken: brokenInnerTest, forwarded: "FAIL\texample.com/rootpkg/inner [build failed]"},
		"json build failure": {arguments: []string{"-json"}, inner: "failed", broken: brokenInnerTest, forwarded: `"Action":"fail","Package":"example.com/rootpkg/inner"`},
	} {
		t.Run(name, func(t *testing.T) {
			root, options := verifiedProject(t)
			writeFiles(t, root, map[string]string{"inner/inner_test.go": test.broken})
			options.TestArguments = test.arguments
			directory := t.TempDir()
			verificationTargetIs(t, directory, "full")
			result := New(options).Run(context.Background())
			if result.Success || result.Status == 0 {
				t.Fatalf("result = %#v", result)
			}
			if !strings.Contains(options.Stdout.(*bytes.Buffer).String(), test.forwarded) {
				t.Fatalf("go test output was not forwarded: %q", options.Stdout.(*bytes.Buffer).String())
			}
			snapshot, _ := readSnapshot(t, directory, "full")
			want := map[string]string{rootSuite: "passed", innerSuite: test.inner, standaloneSuite: "passed"}
			if got := outcomesOf(t, snapshot); !reflect.DeepEqual(got, want) {
				t.Fatalf("outcomes = %v, want %v", got, want)
			}
			if snapshot["success"] != false || !graphIsComplete(t, snapshot) {
				t.Fatalf("snapshot = %#v", snapshot)
			}
			if !reflect.DeepEqual(executedOf(t, snapshot), []string{rootSuite, innerSuite, standaloneSuite}) {
				t.Fatalf("executed = %v", executedOf(t, snapshot))
			}
			if _, err := os.Stat(filepath.Join(root, ".tia/go/state.json")); !os.IsNotExist(err) {
				t.Fatalf("a failing run promoted a graph: %v", err)
			}
		})
	}
}

func TestAFailingRunPassesAPackageWithoutTestFilesAndFailsOneThatDoesNotBuild(t *testing.T) {
	const brokenPackage = "package standalone\n\nfunc Value() int { return undefinedThing }\n"
	for name, test := range map[string]struct {
		arguments  []string
		standalone string
		want       string
	}{
		"plain":                    {standalone: "package standalone\n\nfunc Value() int { return 1 }\n", want: "passed"},
		"json":                     {arguments: []string{"-json"}, standalone: "package standalone\n\nfunc Value() int { return 1 }\n", want: "passed"},
		"plain package that fails": {standalone: brokenPackage, want: "failed"},
		"json package that fails":  {arguments: []string{"-json"}, standalone: brokenPackage, want: "failed"},
	} {
		t.Run(name, func(t *testing.T) {
			root, options := rootPackageProject(t)
			withoutVerificationTarget(t)
			writeFiles(t, root, map[string]string{"inner/inner_test.go": failingInnerTest, "standalone/standalone.go": test.standalone})
			options.TestArguments = test.arguments
			directory := t.TempDir()
			verificationTargetIs(t, directory, "selective")
			if result := New(options).Run(context.Background()); result.Success {
				t.Fatal(result)
			}
			snapshot, _ := readSnapshot(t, directory, "selective")
			want := map[string]string{rootSuite: "passed", innerSuite: "failed", standaloneSuite: test.want}
			if got := outcomesOf(t, snapshot); !reflect.DeepEqual(got, want) {
				t.Fatalf("outcomes = %v, want %v", got, want)
			}
		})
	}
}

func TestAFailingRunWhoseOutputCannotBeAttributedLeavesTheOutcomesUnknown(t *testing.T) {
	all := []string{rootSuite, innerSuite, standaloneSuite}
	for name, test := range map[string]struct {
		stdout, stderr string
		want           map[string]string
	}{
		"nothing printed": {want: map[string]string{rootSuite: "unknown", innerSuite: "unknown", standaloneSuite: "unknown"}},
		"flag error only": {
			stderr: "flag provided but not defined: -nope\nusage: go test [build/test flags] [packages]\n",
			want:   map[string]string{rootSuite: "unknown", innerSuite: "unknown", standaloneSuite: "unknown"},
		},
		"only one package reported": {
			stdout: "ok  \texample.com/rootpkg\t0.003s\n",
			want:   map[string]string{rootSuite: "passed", innerSuite: "unknown", standaloneSuite: "unknown"},
		},
		"a package that contradicts itself": {
			stdout: "ok  \texample.com/rootpkg\t0.003s\nFAIL\texample.com/rootpkg\t0.003s\nFAIL\texample.com/rootpkg/inner\t0.1s\n",
			want:   map[string]string{rootSuite: "unknown", innerSuite: "failed", standaloneSuite: "unknown"},
		},
		"packages that are not suites": {
			stdout: "FAIL\texample.com/elsewhere\t0.1s\nok  \texample.com/rootpkg/inner/other\t0.1s\n",
			want:   map[string]string{rootSuite: "unknown", innerSuite: "unknown", standaloneSuite: "unknown"},
		},
		"no test files": {
			stdout: "?   \texample.com/rootpkg\t[no test files]\nFAIL\texample.com/rootpkg/inner\t0.1s\n",
			want:   map[string]string{rootSuite: "passed", innerSuite: "failed", standaloneSuite: "unknown"},
		},
		"no test files and a failure for one package": {
			stdout: "?   \texample.com/rootpkg\t[no test files]\nFAIL\texample.com/rootpkg\t0.1s\n",
			want:   map[string]string{rootSuite: "unknown", innerSuite: "unknown", standaloneSuite: "unknown"},
		},
		"test level events only": {
			stdout: `{"Action":"fail","Package":"example.com/rootpkg","Test":"TestRoot"}` + "\n" +
				`{"Action":"pass","Package":"example.com/rootpkg/inner","Test":"TestInner"}` + "\n" +
				`{"Action":"skip","Package":"example.com/rootpkg/standalone","Test":"TestStandalone"}` + "\n",
			want: map[string]string{rootSuite: "unknown", innerSuite: "unknown", standaloneSuite: "unknown"},
		},
		"package level events": {
			stdout: `{"Action":"pass","Package":"example.com/rootpkg"}` + "\n" +
				`{"Action":"fail","Package":"example.com/rootpkg/inner","Elapsed":0.1}` + "\n" +
				`{"Action":"skip","Package":"example.com/rootpkg/standalone"}` + "\n",
			want: map[string]string{rootSuite: "passed", innerSuite: "failed", standaloneSuite: "passed"},
		},
		"results on stderr": {
			stderr: "FAIL\texample.com/rootpkg/standalone [setup failed]\n",
			want:   map[string]string{rootSuite: "unknown", innerSuite: "unknown", standaloneSuite: "failed"},
		},
		"a result inside other text": {
			stdout: "--- FAIL: ok  \texample.com/rootpkg\t0.003s\n  FAIL\texample.com/rootpkg/inner\t0.1s\n",
			want:   map[string]string{rootSuite: "unknown", innerSuite: "unknown", standaloneSuite: "unknown"},
		},
		"an unterminated last line": {
			stdout: "FAIL\texample.com/rootpkg/inner\t0.1s",
			want:   map[string]string{rootSuite: "unknown", innerSuite: "failed", standaloneSuite: "unknown"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, options := verifiedProject(t)
			options.GoBinary = fakeGo(t, test.stdout, test.stderr, 1)
			directory := t.TempDir()
			verificationTargetIs(t, directory, "full")
			result := New(options).Run(context.Background())
			if result.Success || result.Status != 1 {
				t.Fatalf("result = %#v", result)
			}
			snapshot, _ := readSnapshot(t, directory, "full")
			if got := outcomesOf(t, snapshot); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("outcomes = %v, want %v", got, test.want)
			}
			if !reflect.DeepEqual(executedOf(t, snapshot), all) {
				t.Fatalf("executed = %v", executedOf(t, snapshot))
			}
		})
	}
}

func TestAnExitStatusOfZeroPassesEverySuiteWhateverTheOutputSays(t *testing.T) {
	_, options := verifiedProject(t)
	options.GoBinary = fakeGo(t, "FAIL\texample.com/rootpkg/inner\t0.1s\n", "", 0)
	directory := t.TempDir()
	verificationTargetIs(t, directory, "full")
	if result := New(options).Run(context.Background()); !result.Success {
		t.Fatal(result)
	}
	snapshot, _ := readSnapshot(t, directory, "full")
	want := map[string]string{rootSuite: "passed", innerSuite: "passed", standaloneSuite: "passed"}
	if got := outcomesOf(t, snapshot); !reflect.DeepEqual(got, want) || snapshot["success"] != true {
		t.Fatalf("outcomes = %v, snapshot = %#v", got, snapshot)
	}
}

func TestFilesChangedDuringTheRunLeaveAnIncompleteGraph(t *testing.T) {
	for name, test := range map[string]struct {
		failing bool
		status  bool
		outcome string
	}{
		"successful run": {status: true, outcome: "passed"},
		"failing run":    {failing: true, outcome: "failed"},
	} {
		t.Run(name, func(t *testing.T) {
			root, options := verifiedProject(t)
			if test.failing {
				writeFiles(t, root, map[string]string{"inner/inner_test.go": failingInnerTest})
			}
			options.GoBinary = touchingGo(t, root)
			directory := t.TempDir()
			verificationTargetIs(t, directory, "full")
			result := New(options).Run(context.Background())
			if result.Success != test.status {
				t.Fatalf("result = %#v", result)
			}
			snapshot, _ := readSnapshot(t, directory, "full")
			if graphIsComplete(t, snapshot) {
				t.Fatal("the graph of a run that saw the project change must be incomplete")
			}
			if snapshot["success"] != test.status || outcomesOf(t, snapshot)[innerSuite] != test.outcome {
				t.Fatalf("snapshot = %#v", snapshot)
			}
			if _, err := os.Stat(filepath.Join(root, ".tia/go/state.json")); !os.IsNotExist(err) {
				t.Fatalf("state was promoted: %v", err)
			}
		})
	}
}

func TestTheRunnerNameFollowsTheStateFileOfTheLane(t *testing.T) {
	root, options := verifiedProject(t)
	directory := t.TempDir()
	verificationTargetIs(t, directory, "full")
	var names []string
	for _, cache := range []string{".tia/go", ".tia/lane-2"} {
		options.CacheDirectory = cache
		if result := New(options).Run(context.Background()); !result.Success {
			t.Fatal(result)
		}
	}
	files, _ := filepath.Glob(filepath.Join(directory, "full", "*.json"))
	if len(files) != 2 {
		t.Fatalf("two lanes of one command must not share a snapshot file: %v", files)
	}
	for _, file := range files {
		data, _ := os.ReadFile(file)
		var snapshot struct {
			Runner string `json:"runner"`
		}
		if err := json.Unmarshal(data, &snapshot); err != nil {
			t.Fatal(err)
		}
		names = append(names, snapshot.Runner)
	}
	sort.Strings(names)
	if want := []string{"go-test:.tia/go/state.json", "go-test:.tia/lane-2/state.json"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("runners = %v, want %v", names, want)
	}
	if _, err := os.Stat(filepath.Join(root, ".tia/lane-2/state.json")); err != nil {
		t.Fatal(err)
	}
}

func TestASnapshotThatCannotBeWrittenIsReported(t *testing.T) {
	blocked := filepath.Join(t.TempDir(), "occupied")
	if err := os.WriteFile(blocked, []byte("a file, not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Run("successful run fails", func(t *testing.T) {
		_, options := verifiedProject(t)
		verificationTargetIs(t, blocked, "full")
		result := New(options).Run(context.Background())
		if result.Success || result.Status != 1 || !strings.Contains(result.Plan.Reason, "write verification snapshot") {
			t.Fatalf("result = %#v", result)
		}
	})
	t.Run("failing run keeps its status", func(t *testing.T) {
		root, options := verifiedProject(t)
		writeFiles(t, root, map[string]string{"inner/inner_test.go": failingInnerTest})
		verificationTargetIs(t, blocked, "full")
		result := New(options).Run(context.Background())
		if result.Success || result.Status != 1 || result.Plan.Mode != "full" {
			t.Fatalf("result = %#v", result)
		}
		if !strings.Contains(options.Stderr.(*bytes.Buffer).String(), "tiacore-go: verification snapshot was not written") {
			t.Fatalf("stderr = %q", options.Stderr.(*bytes.Buffer).String())
		}
	})
}

func TestAnUndiscoverableGraphWritesNoSnapshot(t *testing.T) {
	root, options := verifiedProject(t)
	writeFiles(t, root, map[string]string{"inner/inner_test.go": failingInnerTest})
	realGo, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	// The second `go list` is the one after the run; it fails.
	counter := filepath.Join(t.TempDir(), "lists")
	options.GoBinary = writeScript(t, "#!/bin/sh\nif [ \"$1\" = list ]; then\n  echo x >> '"+counter+"'\n  if [ \"$(wc -l < '"+counter+"')\" -ge 2 ]; then exit 1; fi\nfi\nexec '"+realGo+"' \"$@\"\n")
	directory := t.TempDir()
	verificationTargetIs(t, directory, "full")
	result := New(options).Run(context.Background())
	if result.Success || result.Status == 0 {
		t.Fatalf("result = %#v", result)
	}
	if names := snapshotNames(t, directory, "full"); len(names) != 0 {
		t.Fatalf("snapshot files = %v", names)
	}
}

func TestEarlyFailuresWriteNoSnapshot(t *testing.T) {
	t.Run("discovery fallback", func(t *testing.T) {
		_, options := verifiedProject(t)
		options.PackagePatterns = []string{"./does-not-exist/..."}
		directory := t.TempDir()
		verificationTargetIs(t, directory, "full")
		New(options).Run(context.Background())
		if names := snapshotNames(t, directory, "full"); len(names) != 0 {
			t.Fatalf("snapshot files = %v", names)
		}
	})
	t.Run("planning error", func(t *testing.T) {
		_, options := verifiedProject(t)
		options.CacheDirectory = "../escape"
		directory := t.TempDir()
		verificationTargetIs(t, directory, "full")
		if result := New(options).Run(context.Background()); result.Plan.Mode != "error" {
			t.Fatalf("result = %#v", result)
		}
		if names := snapshotNames(t, directory, "full"); len(names) != 0 {
			t.Fatalf("snapshot files = %v", names)
		}
	})
}

func readResults(t *testing.T, importPaths []string, chunks ...string) *packageResults {
	t.Helper()
	results := newPackageResults(importPaths)
	stream := &resultStream{results: results}
	for _, chunk := range chunks {
		if n, err := stream.Write([]byte(chunk)); err != nil || n != len(chunk) {
			t.Fatalf("Write = %d, %v", n, err)
		}
	}
	stream.endLine()
	return results
}

func TestResultLinesAreReadWhereverTheWritesBreakThem(t *testing.T) {
	paths := []string{"a", "b", "c", "d"}
	text := "ok  \ta\t0.1s\r\nFAIL\tb [build failed]\n\nFAIL\n?   \tc\t[no test files]\nFAIL\td\t(cached)"
	for size := 1; size <= len(text); size++ {
		var chunks []string
		for start := 0; start < len(text); start += size {
			chunks = append(chunks, text[start:min(start+size, len(text))])
		}
		results := readResults(t, paths, chunks...)
		got := []string{results.outcome("a"), results.outcome("b"), results.outcome("c"), results.outcome("d")}
		if want := []string{"passed", "failed", "passed", "failed"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("chunks of %d: outcomes = %v, want %v", size, got, want)
		}
	}
}

func TestOnlyResultLinesAreRetained(t *testing.T) {
	results := newPackageResults([]string{"known"})
	stream := &resultStream{results: results}
	line := strings.Repeat("x", 1<<10) + "\n"
	for range 5000 {
		_, _ = stream.Write([]byte(line))
	}
	_, _ = stream.Write([]byte("ok  \tother\t0s\nok  \tknown\t0s\n"))
	if len(stream.line) != 0 || len(results.seen) != 1 || results.outcome("known") != "passed" {
		t.Fatalf("retained line %d bytes, seen %v", len(stream.line), results.seen)
	}
}

func TestALineLongerThanTheLimitIsDroppedWithoutDisturbingTheNext(t *testing.T) {
	long := "FAIL\tknown\t" + strings.Repeat("x", maxResultLine) + "\n"
	results := readResults(t, []string{"known", "next"}, long[:100], long[100:], "ok  \tnext\t0s\n")
	if results.outcome("known") != "unknown" || results.outcome("next") != "passed" {
		t.Fatalf("seen = %v", results.seen)
	}
}

func TestTeeForwardsEveryByteAndKeepsASharedWriterShared(t *testing.T) {
	results := newPackageResults([]string{"a"})
	shared := &bytes.Buffer{}
	out, err := results.tee(shared, shared)
	if out != err {
		t.Fatal("a writer shared by stdout and stderr must stay one writer, as exec serialises it")
	}
	_, _ = out.Write([]byte("ok  \ta\t0s\nraw"))
	if shared.String() != "ok  \ta\t0s\nraw" || results.outcome("a") != "passed" {
		t.Fatalf("forwarded %q", shared.String())
	}
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	out, err = results.tee(stdout, stderr)
	if out == err {
		t.Fatal("separate writers must stay separate")
	}
}

func TestStreamsOfOneRunMayBeWrittenConcurrently(t *testing.T) {
	names := make([]string, 200)
	for index := range names {
		names[index] = fmt.Sprintf("pkg%d", index)
	}
	results := newPackageResults(names)
	out, err := results.tee(&bytes.Buffer{}, &bytes.Buffer{})
	var group sync.WaitGroup
	for _, writer := range []io.Writer{out, err} {
		group.Add(1)
		go func() {
			defer group.Done()
			for _, name := range names {
				_, _ = writer.Write([]byte("ok  \t" + name + "\t0s\n"))
			}
		}()
	}
	group.Wait()
	for _, name := range names {
		if results.outcome(name) != "passed" {
			t.Fatalf("%s = %s", name, results.outcome(name))
		}
	}
}
