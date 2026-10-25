# tiacore for pytest

This SDK implements tiacore protocol v1 for pytest at static-impact, test-file
granularity. It discovers real pytest files and local Python imports, executes
selected files through pytest, and only promotes a graph after pytest succeeds.

```python
from tiacore import TiaPytestOptions, tia

result = tia(
    TiaPytestOptions(
        root=".",
        changes=("src/package/service.py",),
        environment_fingerprint="python-3.12-pytest-8",
    )
).run()
raise SystemExit(result.status)
```

The adapter deliberately does not claim runtime coverage, cached pytest
outcomes, or case-level selection. Unknown Python or configuration changes run
the complete discovered suite.

## Protocol conformance

`tiacore.create_impact_plan` is certified against every shared vector in
`docs/protocol/conformance/protocol/v1` (`plans.json`, `invalid-graphs.json`,
`canonicalization.json` and the generated `generated-plans.json`), and the plan
it returns matches the TypeScript planner field for field.

- Collections sort by UTF-16 code unit, like the TypeScript planner.
- Changed paths lose trailing slashes and `x/../` segments; paths that name or
  leave the project root raise `ValueError`.
- `ignore_changes` and graph invalidators use the shared glob subset: `*` and
  `?` stay inside one path segment, a whole `**` segment spans zero or more
  segments, `[...]` and `{a,b}` work and dotfiles match.
- `TIA_FRESH` set to `1`, `true`, `yes` or `on` (any case) forces a full run.
- A graph file that is missing, unreadable, not UTF-8 or not valid JSON counts
  as no graph and yields a full run. Symlinks that leave the project are
  skipped, and relative imports are followed.

## Verification snapshots

`tiacore verify -- <command>` runs a command selectively and in full with
`TIA_VERIFICATION_DIRECTORY` and `TIA_VERIFICATION_PHASE` (`selective` or
`full`) set. When both are set, `TiaPytestRunner.run` also writes a
suite-granular snapshot to
`<directory>/<phase>/<sha256 of runner NUL graph fingerprint>.json`: the plan,
the graph it would promote (also after a failed run), the suites it executed and
how each ended. The runner is `pytest:<graph_path>`, for example
`pytest:.tia/pytest/graph.json`. With neither variable set nothing changes; with
only one, or an unknown phase, `run` raises `ValueError` before it plans.

A run that exits 0 passes every executed suite. When a target is set, pytest
also gets `--junitxml=<temporary file>` after `command_arguments`, and a run
that exits 1 is attributed through that report: a testcase belongs to the suite
whose module name (`tests/test_a.py` is `tests.test_a`) is its `classname` or a
dotted prefix of it. A suite with a failing or erroring testcase is `failed`, a
suite whose testcases all passed is `passed`, and a suite without a testcase is
`unknown`. A failure no suite owns (a collection error, a `rootdir` that names
tests differently), a report that is missing or unreadable, a report without any
failure, and any other exit status leave every executed suite `unknown`.
