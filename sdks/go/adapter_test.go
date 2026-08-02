package tiacore

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fixtureOptions(t *testing.T) (string, Options) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "project")
	if err := os.CopyFS(root, os.DirFS("testdata/project")); err != nil {
		t.Fatal(err)
	}
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	return root, Options{
		Root:           root,
		CacheDirectory: ".tia/go",
		Stdout:         stdout,
		Stderr:         stderr,
	}
}

func TestRunnerRecordsSkipsAndSelectsAffectedPackages(t *testing.T) {
	root, options := fixtureOptions(t)
	baseline := New(options).Run(context.Background())
	if !baseline.Success || baseline.Plan.Mode != "full" {
		t.Fatalf("baseline = %#v", baseline)
	}

	skipped := New(options).Run(context.Background())
	if !skipped.Success || skipped.Plan.Mode != "skip" {
		t.Fatalf("skip = %#v", skipped)
	}

	path := filepath.Join(root, "lib/a/a.go")
	if err := os.WriteFile(path, []byte("package a\n\nfunc Value() string { return \"a\" }\n\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	affected := New(options).Run(context.Background())
	if !affected.Success || affected.Plan.Mode != "selective" {
		t.Fatalf("affected = %#v", affected)
	}
	want := []string{"example.com/fixture/app/a", "example.com/fixture/lib/a"}
	if !reflect.DeepEqual(affected.Packages, want) {
		t.Fatalf("packages = %v, want %v", affected.Packages, want)
	}
}

func TestRunnerCanonicalizesASymlinkedProjectRoot(t *testing.T) {
	root, options := fixtureOptions(t)
	linkedRoot := filepath.Join(t.TempDir(), "project-link")
	if err := os.Symlink(root, linkedRoot); err != nil {
		t.Skipf("create project-root symlink: %v", err)
	}
	options.Root = linkedRoot

	baseline := New(options).Run(context.Background())
	if !baseline.Success || baseline.Plan.Mode != "full" {
		t.Fatalf("baseline = %#v", baseline)
	}
	skipped := New(options).Run(context.Background())
	if !skipped.Success || skipped.Plan.Mode != "skip" {
		t.Fatalf("skip = %#v", skipped)
	}
}

func TestRunnerFallsBackForUnknownStructuralCorruptAndEnvironmentChanges(t *testing.T) {
	t.Run("unknown", func(t *testing.T) {
		root, options := fixtureOptions(t)
		if result := New(options).Run(context.Background()); !result.Success {
			t.Fatal(result)
		}
		if err := os.WriteFile(filepath.Join(root, "test-config.yaml"), []byte("mode: strict\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		result := New(options).Run(context.Background())
		if result.Plan.Mode != "full" || !strings.Contains(result.Plan.Reason, "unknown") {
			t.Fatalf("plan = %#v", result.Plan)
		}
	})

	t.Run("structural", func(t *testing.T) {
		root, options := fixtureOptions(t)
		if result := New(options).Run(context.Background()); !result.Success {
			t.Fatal(result)
		}
		path := filepath.Join(root, "go.mod")
		if err := os.WriteFile(path, []byte("module example.com/fixture\n\ngo 1.23\n\n// reviewed change\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		result := New(options).Run(context.Background())
		if result.Plan.Mode != "full" {
			t.Fatalf("plan = %#v", result.Plan)
		}
	})

	t.Run("corrupt", func(t *testing.T) {
		root, options := fixtureOptions(t)
		if result := New(options).Run(context.Background()); !result.Success {
			t.Fatal(result)
		}
		if err := os.WriteFile(filepath.Join(root, ".tia/go/state.json"), []byte("{broken"), 0o644); err != nil {
			t.Fatal(err)
		}
		result := New(options).Run(context.Background())
		if result.Plan.Mode != "full" {
			t.Fatalf("plan = %#v", result.Plan)
		}
	})

	t.Run("environment", func(t *testing.T) {
		_, options := fixtureOptions(t)
		options.Environment = map[string]string{"FIXTURE_MODE": "one"}
		if result := New(options).Run(context.Background()); !result.Success {
			t.Fatal(result)
		}
		options.Environment["FIXTURE_MODE"] = "two"
		result := New(options).Run(context.Background())
		if result.Plan.Mode != "full" || !strings.Contains(result.Plan.Reason, "environment") {
			t.Fatalf("plan = %#v", result.Plan)
		}
	})

	t.Run("shell bookkeeping", func(t *testing.T) {
		_, options := fixtureOptions(t)
		options.Environment = map[string]string{"OLDPWD": "/first/shell/directory"}
		if result := New(options).Run(context.Background()); !result.Success {
			t.Fatal(result)
		}
		options.Environment["OLDPWD"] = "/second/shell/directory"
		result := New(options).Run(context.Background())
		if result.Plan.Mode != "skip" {
			t.Fatalf("shell bookkeeping invalidated the graph: %#v", result.Plan)
		}
	})
}

func TestFailedRunDoesNotPromoteItsSnapshot(t *testing.T) {
	root, options := fixtureOptions(t)
	if result := New(options).Run(context.Background()); !result.Success {
		t.Fatal(result)
	}
	failing := []byte("package a\n\nimport \"testing\"\n\nfunc TestValue(t *testing.T) { t.Fatal(\"expected fixture failure\") }\n")
	if err := os.WriteFile(filepath.Join(root, "app/a/a_test.go"), failing, 0o644); err != nil {
		t.Fatal(err)
	}
	first := New(options).Run(context.Background())
	second := New(options).Run(context.Background())
	if first.Success || second.Success {
		t.Fatalf("failed runs were accepted: first=%#v second=%#v", first, second)
	}
	if first.Plan.Mode != "selective" || second.Plan.Mode != "selective" {
		t.Fatalf("failed change was not rerun: first=%s second=%s", first.Plan.Mode, second.Plan.Mode)
	}
}

func TestCreatePlanNormalizesWindowsPathsAndPreservesResourceLocks(t *testing.T) {
	suite := Suite{Adapter: "go-test", File: "app/a/a_test.go", ID: "go-test:a", Project: "fixture", ResourceLocks: []string{"database"}}
	graph := Graph{
		ProtocolVersion:        ProtocolVersion,
		Complete:               true,
		Fingerprint:            "catalog",
		EnvironmentFingerprint: "go",
		Suites:                 []Suite{suite},
		Observations:           []Observation{{Confidence: "inferred", Kind: "import", Source: "lib/a/a.go", SuiteID: suite.ID}},
	}
	plan := createPlan(graph, &graph, []string{`lib\a\a.go`}, false)
	if plan.Mode != "selective" || !reflect.DeepEqual(plan.ChangedFiles, []string{"lib/a/a.go"}) {
		t.Fatalf("plan = %#v", plan)
	}
	if !reflect.DeepEqual(plan.ResourceLocks, []string{"database"}) {
		t.Fatalf("locks = %v", plan.ResourceLocks)
	}
}

func TestNormalizePathRejectsEscapes(t *testing.T) {
	for _, value := range []string{"../outside.go", "/tmp/outside.go", `C:\\outside.go`, "https://example.test/file.go"} {
		if _, err := normalizePath(value); err == nil {
			t.Errorf("normalizePath(%q) accepted an escape", value)
		}
	}
}
