# tiacore for Go

This SDK implements tiacore protocol v1 for Go at static-impact granularity. It
asks the Go toolchain for the real package and test inventory, follows
transitive local imports, and passes the unique affected packages back to
`go test`.

Install or run it from an exact reviewed revision:

```sh
go run github.com/usescherie/tiacore/sdks/go/cmd/tiacore-go@<exact-commit> \
  -- -timeout=30m
```

The first run executes `go test ./...` and atomically records
`.tia/go/state.json`. Later runs do one of three things:

- skip when the filesystem baseline did not change;
- run only packages whose test files or transitive local inputs changed;
- run the full package pattern when state, structure, environment, or an
  executable change is unknown.

`go test` owns package workers and its native content-addressed build and test
cache. The adapter does not claim cached outcomes, case-level selection, or
coverage reconstruction. A selected test file expands conservatively to its Go
package because the native runner does not execute file paths as isolated test
suites.

Use `--packages` more than once to replace the default `./...` pattern,
`--force` or `TIA_FRESH=1` for a full run, and `--json` for a machine-readable
plan. Flags after `--` are passed to `go test` before the selected package list.

The library API keeps the same boundary:

```go
result := tiacore.New(tiacore.Options{
    Root:          ".",
    TestArguments: []string{"-timeout=30m"},
}).Run(context.Background())
os.Exit(result.Status)
```

Keep `.tia/` out of version control. Every Git worktree gets an independent
baseline when the cache stays project-relative.
