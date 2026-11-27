package tiacore

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestIgnoreChangesAndOnUnknownChangeReachThePlan(t *testing.T) {
	root, options := rootPackageProject(t)
	if result := New(options).Run(context.Background()); !result.Success {
		t.Fatal(result)
	}
	statePath := filepath.Join(root, ".tia/go/state.json")
	baseline, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	writeFiles(t, root, map[string]string{
		"NOTES.md":       "unknown to the graph\n",
		"inner/inner.go": "package inner\n\nimport root \"example.com/rootpkg\"\n\nfunc Value() string { return root.Value() + \"!\" }\n",
	})
	// Every plan starts from the baseline: a run that executes tests promotes
	// the changes it saw.
	plan := func(mutate func(*Options)) Plan {
		if err := os.WriteFile(statePath, baseline, 0o644); err != nil {
			t.Fatal(err)
		}
		copied := options
		mutate(&copied)
		return New(copied).Run(context.Background()).Plan
	}
	if got := plan(func(*Options) {}); got.Mode != "full" || !strings.Contains(got.Reason, "unknown to the impact graph: NOTES.md") {
		t.Fatalf("default plan = %#v", got)
	}
	if got := plan(func(o *Options) { o.OnUnknownChange = "full" }); got.Mode != "full" {
		t.Fatalf("full plan = %#v", got)
	}
	if got := plan(func(o *Options) { o.OnUnknownChange = "ignore" }); got.Mode != "selective" ||
		strings.Join(got.Selected, ",") != "go-package:example.com/rootpkg/inner" {
		t.Fatalf("ignore plan = %#v", got)
	}
	if got := plan(func(o *Options) { o.IgnoreChanges = []string{"*.md"} }); got.Mode != "selective" {
		t.Fatalf("ignored markdown plan = %#v", got)
	}
	if got := plan(func(o *Options) { o.IgnoreChanges = []string{"*.md", "inner/**"} }); got.Mode != "skip" {
		t.Fatalf("everything ignored plan = %#v", got)
	}
}

func TestAnUnknownOnUnknownChangeValueFailsBeforePlanning(t *testing.T) {
	_, options := rootPackageProject(t)
	options.OnUnknownChange = "Full"
	result := New(options).Run(context.Background())
	if result.Status != 1 || result.Success || result.Plan.Mode != "error" {
		t.Fatalf("result = %#v", result)
	}
	if stderr := options.Stderr.(*bytes.Buffer).String(); !strings.Contains(stderr, "OnUnknownChange") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestCommandLineIgnoreChangeAndOnUnknownChange(t *testing.T) {
	binary := buildCLI(t)
	root, _ := rootPackageProject(t)
	run := func(arguments ...string) (string, string, int) {
		command := exec.Command(binary, append([]string{"-root", root}, arguments...)...)
		command.Env = append(command.Environ(), "TIA_FRESH=")
		var stdout, stderr bytes.Buffer
		command.Stdout, command.Stderr = &stdout, &stderr
		err := command.Run()
		code := 0
		if exitError, ok := err.(*exec.ExitError); ok {
			code = exitError.ExitCode()
		}
		return stdout.String(), stderr.String(), code
	}
	if _, stderr, code := run(); code != 0 {
		t.Fatalf("baseline exit %d: %s", code, stderr)
	}
	writeFiles(t, root, map[string]string{"NOTES.md": "unknown\n", "docs/guide.md": "unknown\n"})
	for _, arguments := range [][]string{
		{"-on-unknown-change", "ignore"},
		{"-ignore-change", "*.md", "-ignore-change", "docs/**"},
	} {
		if stdout, stderr, code := run(arguments...); code != 0 || !strings.HasPrefix(stdout, "tiacore-go: skip:") {
			t.Fatalf("%v: exit %d stdout %q stderr %q", arguments, code, stdout, stderr)
		}
	}
	if stdout, _, code := run("-on-unknown-change", "full"); code != 0 || !strings.HasPrefix(stdout, "tiacore-go: full: changed file is unknown") {
		t.Fatalf("full: exit %d stdout %q", code, stdout)
	}
	if _, stderr, code := run("-on-unknown-change", "sometimes"); code != 2 || !strings.Contains(stderr, "-on-unknown-change") {
		t.Fatalf("invalid: exit %d stderr %q", code, stderr)
	}
}
