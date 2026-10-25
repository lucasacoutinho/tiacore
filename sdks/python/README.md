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
