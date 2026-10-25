# tiacore for Go

This SDK implements tiacore protocol v1 for Go at static-impact, package
granularity. It asks the Go toolchain for the real package and test inventory,
follows transitive local imports, and passes the affected packages back to
`go test`.

Install or run it from an exact reviewed revision:

```sh
go run github.com/lucasacoutinho/tiacore/sdks/go/cmd/tiacore-go@<exact-commit> \
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
coverage reconstruction.

The environment fingerprint includes Go's build environment, forwarded test
arguments, and process environment values. Shell bookkeeping (`PWD`, `OLDPWD`,
`SHLVL`, and `_`) is excluded because the explicit project root already owns
path identity and those values change without changing test behavior.

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

## Protocol conformance

`tiacore.CreateImpactPlan` is certified against every shared vector in
`docs/protocol/conformance/protocol/v1` (`plans.json`, `invalid-graphs.json`,
`canonicalization.json` and the generated `generated-plans.json`), and the plan
it returns matches the TypeScript planner field for field, including the
`dependsOn` closure and `allowedSuites` policy.

- Collections sort by UTF-16 code unit, like the TypeScript planner.
- Changed paths lose trailing slashes and `x/../` segments; paths that name or
  leave the project root are rejected.
- Invalidators and `IgnoreChanges` use the shared glob subset: `*` and `?` stay
  inside one path segment, a whole `**` segment spans zero or more segments,
  `[...]` and `{a,b}` work and dotfiles match.
- `TIA_FRESH` set to `1`, `true`, `yes` or `on` (any ASCII case) in the process
  environment forces a full run.
- A package at the project root is a suite like any other.

## Verification

`tiacore verify -- <command>` runs a command twice, selective then fresh, and
compares what each run executed and how it ended. It sets
`TIA_VERIFICATION_DIRECTORY` and `TIA_VERIFICATION_PHASE` (`selective` or
`full`); when both are in the process environment, a run writes one snapshot,
`<directory>/<phase>/<sha256 of runner NUL graph fingerprint>.json`, after
`go test` finished, whatever its exit status. Setting only one of them, or a
phase other than `selective` or `full`, fails the run before it plans anything.
With neither set nothing changes: no snapshot, and the output of `go test`
passes through untouched.

- The runner is `go-test:` plus the state file relative to the project root, for
  example `go-test:.tia/go/state.json`, so two lanes with different cache
  directories stay apart.
- The suites that ran are the plan's selected suites (every suite for a full
  plan, none for a skip plan). The graph is the one the run promotes, found
  again after `go test`; it is incomplete when project files changed during the
  run, and no snapshot is written when it cannot be found.
- An exit status of 0 passes every executed suite. For any other status the
  snapshot reads the package results `go test` printed (`ok  \t<package>`,
  `FAIL\t<package>` with or without `[build failed]` or `[setup failed]`,
  `?   \t<package>\t[no test files]`, and the package-level events of `-json`):
  a package that reported a result has it (a package without test files was
  built and passed), and every other suite is `unknown`. A package that reported
  both results is `unknown` too.
- The environment fingerprint ignores the two variables, so a verification
  selects against the state of an earlier run made without them.
