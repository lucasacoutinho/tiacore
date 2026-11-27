package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"

	tiacore "github.com/lucasacoutinho/tiacore/v2/sdks/go"
)

type repeatedFlag []string

func (values *repeatedFlag) String() string { return strings.Join(*values, ",") }
func (values *repeatedFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func main() {
	var patterns, ignoreChanges, envAllow repeatedFlag
	root := flag.String("root", ".", "Go project root")
	cacheDirectory := flag.String("cache-dir", ".tia/go", "project-relative tiacore state directory")
	goBinary := flag.String("go", "go", "Go command")
	project := flag.String("project", "", "stable project name (defaults to the main module path)")
	force := flag.Bool("force", false, "run the full package set")
	jsonPlan := flag.Bool("json", false, "print the plan as JSON")
	flag.Var(&patterns, "packages", "Go package pattern; repeat for multiple patterns")
	flag.Var(&ignoreChanges, "ignore-change", "glob of changed files that never select a package; repeat for multiple globs")
	flag.Var(&envAllow, "env-allow", "process environment variable to include in the cache fingerprint; when set, unlisted variables are ignored; repeat for multiple names")
	onUnknownChange := flag.String("on-unknown-change", "full", "what a change the stored graph does not know triggers: full or ignore")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: tiacore-go [adapter flags] [-- go-test-flags]")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *onUnknownChange != "full" && *onUnknownChange != "ignore" {
		fmt.Fprintf(flag.CommandLine.Output(), "invalid value %q for flag -on-unknown-change: must be full or ignore\n", *onUnknownChange)
		flag.Usage()
		os.Exit(2)
	}

	result := tiacore.New(tiacore.Options{
		Root:                 *root,
		CacheDirectory:       *cacheDirectory,
		GoBinary:             *goBinary,
		PackagePatterns:      patterns,
		Project:              *project,
		TestArguments:        flag.Args(),
		EnvironmentAllowlist: envAllow,
		ForceFull:            *force,
		IgnoreChanges:        ignoreChanges,
		OnUnknownChange:      *onUnknownChange,
		JSONPlan:             *jsonPlan,
		Stdout:               os.Stdout,
		Stderr:               os.Stderr,
	}).Run(context.Background())
	os.Exit(result.Status)
}
