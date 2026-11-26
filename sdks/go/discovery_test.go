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
