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
