from __future__ import annotations

from fnmatch import fnmatch
from pathlib import PurePosixPath
from typing import Any

PROTOCOL_VERSION = 1


def _normalized_path(value: str) -> str:
    path = value.replace("\\", "/")
    if (
        not path
        or "\x00" in path
        or "://" in path
        or path.startswith("/")
        or (len(path) >= 2 and path[1] == ":")
    ):
        raise ValueError(f"unsafe tiacore path: {value}")
    parts = PurePosixPath(path).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError(f"unsafe tiacore path: {value}")
    return "/".join(parts)


def _locks(catalog: list[dict[str, Any]], selected: set[str]) -> list[str]:
    return sorted(
        {
            lock
            for suite in catalog
            if suite["id"] in selected
            for lock in suite.get("resourceLocks", [])
        }
    )


def _full_plan(
    catalog: list[dict[str, Any]],
    changed_files: list[str],
    reason: str,
) -> dict[str, Any]:
    selected = sorted(suite["id"] for suite in catalog)
    return {
        "cached": [],
        "changedFiles": changed_files,
        "mode": "full",
        "protocolVersion": PROTOCOL_VERSION,
        "reason": reason,
        "reasons": {suite_id: [reason] for suite_id in selected},
        "resourceLocks": _locks(catalog, set(selected)),
        "selected": selected,
    }


def create_impact_plan(
    *,
    catalog: list[dict[str, Any]],
    changes: list[str],
    environment_fingerprint: str,
    fingerprint: str,
    graph: dict[str, Any] | None,
    force_full: bool = False,
    ignore_changes: tuple[str, ...] = (),
    on_unknown_change: str = "full",
) -> dict[str, Any]:
    changed_files = sorted({_normalized_path(path) for path in changes})
    if force_full:
        return _full_plan(catalog, changed_files, "full run requested")
    if graph is None:
        return _full_plan(
            catalog,
            changed_files,
            "no compatible impact graph exists",
        )
    if graph.get("protocolVersion") != PROTOCOL_VERSION:
        return _full_plan(
            catalog,
            changed_files,
            "impact graph protocol changed",
        )
    if not graph.get("complete"):
        return _full_plan(catalog, changed_files, "impact graph is incomplete")
    if graph.get("environmentFingerprint") != environment_fingerprint:
        return _full_plan(
            catalog,
            changed_files,
            "execution environment changed",
        )
    if graph.get("fingerprint") != fingerprint:
        return _full_plan(catalog, changed_files, "project structure changed")

    for invalidator in graph.get("invalidators", []):
        for changed in changed_files:
            if fnmatch(changed, invalidator["pattern"]):
                return _full_plan(
                    catalog,
                    changed_files,
                    f"{invalidator['reason']}: {changed}",
                )

    suite_by_id = {suite["id"]: suite for suite in catalog}
    selected: set[str] = set()
    reasons: dict[str, list[str]] = {}
    known_sources = set(graph.get("knownSources", []))
    observations_by_source: dict[str, list[dict[str, Any]]] = {}
    for observation in graph.get("observations", []):
        source = observation["source"]
        known_sources.add(source)
        observations_by_source.setdefault(source, []).append(observation)
    test_files = {suite["file"]: suite["id"] for suite in catalog}

    for changed in changed_files:
        if any(fnmatch(changed, pattern) for pattern in ignore_changes):
            continue
        suite_id = test_files.get(changed)
        if suite_id is not None:
            selected.add(suite_id)
            reasons.setdefault(suite_id, []).append(
                f"suite file changed: {changed}"
            )
            continue
        observations = observations_by_source.get(changed, [])
        if observations:
            for observation in observations:
                suite_id = observation["suiteId"]
                if suite_id not in suite_by_id:
                    continue
                selected.add(suite_id)
                reasons.setdefault(suite_id, []).append(
                    f"observed dependency changed: {changed}"
                )
            continue
        if changed not in known_sources and on_unknown_change == "full":
            return _full_plan(
                catalog,
                changed_files,
                f"changed file is unknown to the impact graph: {changed}",
            )

    pending = list(selected)
    while pending:
        suite_id = pending.pop()
        suite = suite_by_id.get(suite_id)
        if suite is None:
            continue
        for dependency in suite.get("dependsOn", []):
            if dependency not in suite_by_id or dependency in selected:
                continue
            selected.add(dependency)
            reasons.setdefault(dependency, []).append(
                f"dependency of {suite_id}"
            )
            pending.append(dependency)

    selected_ids = sorted(selected)
    cached = sorted(set(suite_by_id) - selected)
    count = len(selected_ids)
    return {
        "cached": cached,
        "changedFiles": changed_files,
        "mode": "skip" if count == 0 else "selective",
        "protocolVersion": PROTOCOL_VERSION,
        "reason": (
            "no suites are affected"
            if count == 0
            else f"{count} affected {'suite' if count == 1 else 'suites'}"
        ),
        "reasons": {
            suite_id: sorted(set(reasons[suite_id]))
            for suite_id in selected_ids
        },
        "resourceLocks": _locks(catalog, selected),
        "selected": selected_ids,
    }
