package tiacore

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestBuildTagsFromTestArgumentsReachDiscovery(t *testing.T) {
	t.Setenv("TIA_FRESH", "")
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		"go.mod":                      "module example.com/tagged\n\ngo 1.23\n",
		"lib/lib.go":                  "package lib\n\nfunc Value() int { return 1 }\n",
		"app/app.go":                  "package app\n\nfunc Name() string { return \"app\" }\n",
		"app/app_integration_test.go": "//go:build integration\n\npackage app\n\nimport (\n\t\"testing\"\n\n\t\"example.com/tagged/lib\"\n)\n\nfunc TestIntegration(t *testing.T) { _ = lib.Value() }\n",
		"other/other.go":              "package other\n\nfunc Other() int { return 2 }\n",
		"other/other_test.go":         "package other\n\nimport \"testing\"\n\nfunc TestOther(t *testing.T) { _ = Other() }\n",
	})
	for name, arguments := range map[string][]string{
		"joined":    {"-count=1", "-tags=integration"},
		"separate":  {"-tags", "integration", "-count=1"},
		"long form": {"--tags=integration"},
	} {
		t.Run(name, func(t *testing.T) {
			if err := os.RemoveAll(filepath.Join(root, ".tia")); err != nil {
				t.Fatal(err)
			}
			options := Options{Root: root, TestArguments: arguments, Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}}
			if result := New(options).Run(context.Background()); !result.Success || result.Plan.Mode != "full" {
				t.Fatalf("baseline = %#v", result)
			}
			writeFiles(t, root, map[string]string{"lib/lib.go": "package lib\n\nfunc Value() int { return 3 }\n"})
			t.Cleanup(func() {
				writeFiles(t, root, map[string]string{"lib/lib.go": "package lib\n\nfunc Value() int { return 1 }\n"})
			})
			result := New(options).Run(context.Background())
			want := []string{"example.com/tagged/app", "example.com/tagged/lib"}
			if result.Plan.Mode != "selective" || !reflect.DeepEqual(result.Packages, want) {
				t.Fatalf("plan %s packages %v, want selective %v", result.Plan.Mode, result.Packages, want)
			}
		})
	}
}

func TestGoListBuildFlagsKeepOnlyFlagsThatShapeTheBuild(t *testing.T) {
	got := goListBuildFlags([]string{
		"-run", "TestX", "-tags", "a,b", "-race", "-count=1", "-v",
		"--mod=mod", "-modfile", "alt.mod", "-msan=false", "-asan", "-overlay=o.json",
		"-timeout", "30m", "-args", "-tags=ignored",
	})
	want := []string{"-tags", "a,b", "-race", "--mod=mod", "-modfile", "alt.mod", "-msan=false", "-asan", "-overlay=o.json"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("goListBuildFlags = %q, want %q", got, want)
	}
	if got := goListBuildFlags(nil); len(got) != 0 {
		t.Fatalf("goListBuildFlags(nil) = %q", got)
	}
}

func TestTheDefaultProjectIsStableAcrossWorkspaceModules(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		"go.work":     "go 1.23\n\nuse (\n\t./a\n\t./b\n)\n",
		"a/go.mod":    "module example.com/a\n\ngo 1.23\n",
		"a/a.go":      "package a\n\nfunc A() int { return 1 }\n",
		"a/a_test.go": "package a\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) { _ = A() }\n",
		"b/go.mod":    "module example.com/b\n\ngo 1.23\n",
		"b/b.go":      "package b\n\nfunc B() int { return 1 }\n",
		"b/b_test.go": "package b\n\nimport \"testing\"\n\nfunc TestB(t *testing.T) { _ = B() }\n",
	})
	options := Options{PackagePatterns: []string{"./a/...", "./b/..."}, Stderr: &bytes.Buffer{}}
	for attempt := 0; attempt < 12; attempt++ {
		found := discoverFixture(t, options, root)
		for _, suite := range found.Graph.Suites {
			if suite.Project != "example.com/a" {
				t.Fatalf("attempt %d: suite %s has project %q, want the first main module example.com/a", attempt, suite.ID, suite.Project)
			}
		}
	}
}
