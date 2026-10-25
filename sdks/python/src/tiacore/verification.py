"""Verification snapshots for `tiacore verify`.

`tiacore verify -- <command>` runs a command twice, once selectively and once
in full, with TIA_VERIFICATION_DIRECTORY and TIA_VERIFICATION_PHASE set. A
runner that executes tests writes one suite-granular ("protocol") snapshot per
phase into `<directory>/<phase>/`, and the verifier compares the two phases.
Nothing here runs when neither variable is set.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import xml.etree.ElementTree as ElementTree
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePath, PurePosixPath
from typing import Any, Iterator, Mapping, Sequence

from .protocol import sorted_utf16

DIRECTORY_ENV = "TIA_VERIFICATION_DIRECTORY"
PHASE_ENV = "TIA_VERIFICATION_PHASE"
SNAPSHOT_SCHEMA = 1

# pytest exits 1 when tests ran and some failed. Every other non-zero status
# (interrupted, internal error, usage error, nothing collected) says nothing
# about which suite is to blame.
PYTEST_TESTS_FAILED = 1


@dataclass(frozen=True)
class VerificationTarget:
    """Where `tiacore verify` collects this run's snapshot, and for which phase."""

    directory: Path
    phase: str


def verification_target(
    environment: Mapping[str, str],
) -> VerificationTarget | None:
    """The target set up through the environment, or None when neither
    variable is set. Raises ValueError for a half-set or invalid target, so a
    run fails before it plans or executes anything."""
    directory = environment.get(DIRECTORY_ENV)
    phase = environment.get(PHASE_ENV)
    if directory is None and phase is None:
        return None
    if directory is None or phase is None:
        raise ValueError(f"{DIRECTORY_ENV} and {PHASE_ENV} must be set together")
    if phase not in ("selective", "full"):
        raise ValueError(f"{PHASE_ENV} must be selective or full")
    return VerificationTarget(directory=Path(directory), phase=phase)


def runner_name(adapter: str, root: Path, state_path: Path) -> str:
    """`<adapter>:<state file relative to the root, with forward slashes>`:
    the same in both phases, and apart for two lanes of one command."""
    try:
        relative = PurePath(os.path.relpath(state_path, root)).as_posix()
    except ValueError:
        relative = state_path.as_posix()
    return f"{adapter}:{relative}"


@dataclass(frozen=True)
class JunitReport:
    """The temporary junit XML file one pytest invocation writes, if any."""

    path: Path | None

    @property
    def arguments(self) -> tuple[str, ...]:
        return () if self.path is None else (f"--junitxml={self.path}",)


@contextmanager
def junit_report(enabled: bool) -> Iterator[JunitReport]:
    """A junit report location that is removed on exit. Disabled, it names
    nothing and adds no argument."""
    if not enabled:
        yield JunitReport(None)
        return
    with tempfile.TemporaryDirectory(prefix="tiacore-junit-") as directory:
        yield JunitReport(Path(directory) / "report.xml")


def _testcases(report: Path) -> list[tuple[str, bool]] | None:
    """(classname, failed or errored) per testcase, or None when the report
    cannot be read."""
    try:
        tree = ElementTree.parse(report)
    except (ElementTree.ParseError, OSError, ValueError, RecursionError):
        return None
    return [
        (
            case.get("classname") or "",
            any(child.tag in ("failure", "error") for child in case),
        )
        for case in tree.getroot().iter("testcase")
    ]


def _module_name(file: str) -> str:
    return ".".join(PurePosixPath(file).with_suffix("").parts)


def _owner(classname: str, modules: Mapping[str, list[str]]) -> str | None:
    """The one suite whose module is the classname or a dotted prefix of it
    (a classname is the module, optionally followed by class names). None
    when no suite or several suites could own it."""
    owners: list[str] = []
    candidate = classname
    while candidate:
        owners.extend(modules.get(candidate, ()))
        candidate = candidate.rpartition(".")[0]
    return owners[0] if len(owners) == 1 else None


def suite_outcomes(
    executed: Sequence[Mapping[str, Any]],
    status: int,
    report: Path | None,
) -> dict[str, str]:
    """How each executed suite ended, as the verifier's passed, failed or
    unknown.

    Status 0 passes every suite. Status 1 is attributed through the junit
    report, and only when the report accounts for every failure: a suite with
    a failing or erroring testcase failed, a suite whose testcases all passed
    passed, a suite without a testcase is unknown. A failure no executed
    suite owns (a collection error, a rootdir that names tests differently),
    an unreadable report, a status-1 report with no failure in it and every
    other status leave all suites unknown, never a guess.
    """
    ids = [suite["id"] for suite in executed]
    if status == 0:
        return dict.fromkeys(ids, "passed")
    unknown = dict.fromkeys(ids, "unknown")
    if status != PYTEST_TESTS_FAILED or report is None:
        return unknown
    cases = _testcases(report)
    if cases is None:
        return unknown
    modules: dict[str, list[str]] = {}
    for suite in executed:
        modules.setdefault(_module_name(suite["file"]), []).append(suite["id"])
    owned: set[str] = set()
    failed: set[str] = set()
    failures = 0
    for classname, failing in cases:
        owner = _owner(classname, modules)
        failures += failing
        if owner is None:
            if failing:
                return unknown
            continue
        owned.add(owner)
        if failing:
            failed.add(owner)
    if failures == 0:
        return unknown
    return {
        suite_id: (
            "failed"
            if suite_id in failed
            else "passed"
            if suite_id in owned
            else "unknown"
        )
        for suite_id in ids
    }


def snapshot_name(runner: str, fingerprint: str) -> str:
    return hashlib.sha256(f"{runner}\0{fingerprint}".encode()).hexdigest()


def write_snapshot(
    target: VerificationTarget,
    *,
    runner: str,
    plan: Mapping[str, Any],
    graph: Mapping[str, Any],
    outcomes: Mapping[str, str],
    success: bool,
) -> Path:
    """Write the run's protocol snapshot as `runner`'s file in the target's
    phase directory, beside it first and then renamed into place so a reader
    never sees a partial file. `outcomes` holds one entry per executed suite."""
    directory = target.directory / target.phase
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{snapshot_name(runner, graph['fingerprint'])}.json"
    snapshot = {
        "executedTestIds": sorted_utf16(outcomes),
        "generatedAt": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "graph": graph,
        "kind": "protocol",
        "phase": target.phase,
        "plan": plan,
        "runner": runner,
        "schema": SNAPSHOT_SCHEMA,
        "success": success,
        "suiteOutcomes": dict(outcomes),
    }
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            f"{json.dumps(snapshot, separators=(',', ':'), sort_keys=True)}\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return path
