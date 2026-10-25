from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from xml.etree import ElementTree

# Logs the test files it is given, one per line, in TIACORE_PYTEST_FIXTURE_LOG.
# Optional behaviour, each driven by an environment variable:
#   TIACORE_PYTEST_FIXTURE_ARGV     appends its arguments there, as one JSON line
#   TIACORE_PYTEST_FIXTURE_EXIT     the exit status (default 0)
#   TIACORE_PYTEST_FIXTURE_OUTCOMES JSON [[classname, name, outcome], ...] with
#                                   outcome passed, failed, error or skipped,
#                                   written as pytest's junit XML to --junitxml
#   TIACORE_PYTEST_FIXTURE_REPORT   text written verbatim to --junitxml instead
log = os.environ["TIACORE_PYTEST_FIXTURE_LOG"]
arguments = sys.argv[1:]
files = [argument for argument in arguments if argument.endswith(".py")]
with Path(log).open("a", encoding="utf-8") as target:
    for file in files:
        target.write(f"{file}\n")

argv_log = os.environ.get("TIACORE_PYTEST_FIXTURE_ARGV")
if argv_log is not None:
    with Path(argv_log).open("a", encoding="utf-8") as target:
        target.write(f"{json.dumps(arguments)}\n")

report = next(
    (
        argument.partition("=")[2]
        for argument in arguments
        if argument.startswith("--junitxml=")
    ),
    None,
)
raw = os.environ.get("TIACORE_PYTEST_FIXTURE_REPORT")
outcomes = os.environ.get("TIACORE_PYTEST_FIXTURE_OUTCOMES")
if report is not None and raw is not None:
    Path(report).write_text(raw, encoding="utf-8")
elif report is not None and outcomes is not None:
    suite = ElementTree.Element("testsuite", name="pytest")
    for classname, name, outcome in json.loads(outcomes):
        case = ElementTree.SubElement(
            suite, "testcase", classname=classname, name=name
        )
        if outcome == "failed":
            ElementTree.SubElement(case, "failure", message="assert False")
        elif outcome == "error":
            ElementTree.SubElement(case, "error", message="collection failure")
        elif outcome == "skipped":
            ElementTree.SubElement(case, "skipped", message="skipped")
    suites = ElementTree.Element("testsuites", name="pytest tests")
    suites.append(suite)
    ElementTree.ElementTree(suites).write(
        report, encoding="utf-8", xml_declaration=True
    )

sys.exit(int(os.environ.get("TIACORE_PYTEST_FIXTURE_EXIT", "0")))
