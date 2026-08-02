package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"

	tiacore "github.com/usescherie/tiacore/sdks/go"
)

type repeatedFlag []string

func (values *repeatedFlag) String() string { return strings.Join(*values, ",") }
func (values *repeatedFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func main() {
	var patterns repeatedFlag
	root := flag.String("root", ".", "Go project root")
	cacheDirectory := flag.String("cache-dir", ".tia/go", "project-relative tiacore state directory")
	goBinary := flag.String("go", "go", "Go command")
	project := flag.String("project", "", "stable project name (defaults to the main module path)")
	force := flag.Bool("force", false, "run the full package set")
	jsonPlan := flag.Bool("json", false, "print the plan as JSON")
	flag.Var(&patterns, "packages", "Go package pattern; repeat for multiple patterns")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: tiacore-go [adapter flags] [-- go-test-flags]")
		flag.PrintDefaults()
	}
	flag.Parse()

	result := tiacore.New(tiacore.Options{
		Root:            *root,
		CacheDirectory:  *cacheDirectory,
		GoBinary:        *goBinary,
		PackagePatterns: patterns,
		Project:         *project,
		TestArguments:   flag.Args(),
		ForceFull:       *force,
		JSONPlan:        *jsonPlan,
		Stdout:          os.Stdout,
		Stderr:          os.Stderr,
	}).Run(context.Background())
	os.Exit(result.Status)
}
