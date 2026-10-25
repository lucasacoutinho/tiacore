from __future__ import annotations

import os
import sys
from pathlib import Path

log = os.environ["TIACORE_PYTEST_FIXTURE_LOG"]
files = [argument for argument in sys.argv[1:] if argument.endswith(".py")]
with Path(log).open("a", encoding="utf-8") as target:
    for file in files:
        target.write(f"{file}\n")
