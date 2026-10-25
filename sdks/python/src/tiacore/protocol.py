"""Protocol v1 impact planning.

This module mirrors the TypeScript planner (``src/engine/plan/protocol.ts``) and
is certified against the shared vectors in ``docs/protocol/conformance/protocol/v1``.
Ordering is by UTF-16 code unit, so it agrees with TypeScript for non-BMP text.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, Sequence

PROTOCOL_VERSION = 1

MAX_PATH_LENGTH = 4096
LIMITS = {
    "invalidators": 10_000,
    "knownSources": 1_000_000,
    "observations": 1_000_000,
    "relationsPerSuite": 100_000,
    "stringLength": 8_192,
    "suites": 100_000,
}
EDGE_KINDS = frozenset(
    {
        "capability",
        "configuration",
        "conservative",
        "database",
        "executed",
        "fixture",
        "import",
        "lazy",
        "route",
        "view",
    }
)
EDGE_CONFIDENCES = frozenset({"conservative", "exact", "inferred", "observed"})

# ECMAScript String.prototype.trim whitespace, which is not str.strip's set.
_JS_WHITESPACE = (
    "\t\n\v\f\r          "
    "        　﻿"
)


def utf16_key(value: str) -> bytes:
    """Sort key that orders strings by UTF-16 code unit."""
    return value.encode("utf-16-be", "surrogatepass")


def utf16_length(value: str) -> int:
    return len(utf16_key(value)) // 2


def sorted_utf16(values: Iterable[str]) -> list[str]:
    return sorted(values, key=utf16_key)


def sorted_unique_utf16(values: Iterable[str]) -> list[str]:
    return sorted_utf16(set(values))


def _is_scheme_start(char: str) -> bool:
    return "a" <= char <= "z" or "A" <= char <= "Z"


def _has_scheme(segment: str) -> bool:
    colon = segment.find(":")
    if colon < 1 or not _is_scheme_start(segment[0]):
        return False
    return all(
        _is_scheme_start(char) or "0" <= char <= "9" or char in "+-."
        for char in segment[1:colon]
    )


def normalize_path(value: str) -> str:
    """Normalize a project-relative path; raise ValueError when it is unsafe.

    ``\\`` becomes ``/``, empty and ``.`` segments are dropped (so trailing
    slashes disappear), ``..`` pops a segment and a path that climbs out of
    the project, is absolute, empty, longer than 4096 UTF-16 units or starts
    with a URI scheme is rejected.
    """
    if "\x00" in value:
        raise ValueError(f"unsafe tiacore path: {value!r}")
    if utf16_length(value) > MAX_PATH_LENGTH:
        raise ValueError(f"unsafe tiacore path: {value!r}")
    slashed = value.replace("\\", "/")
    if slashed.startswith("/"):
        raise ValueError(f"unsafe tiacore path: {value!r}")
    kept: list[str] = []
    for segment in slashed.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if not kept:
                raise ValueError(f"unsafe tiacore path: {value!r}")
            kept.pop()
            continue
        kept.append(segment)
    if not kept or _has_scheme(kept[0]):
        raise ValueError(f"unsafe tiacore path: {value!r}")
    return "/".join(kept)


def _normalized_path(value: str) -> str:
    return normalize_path(value)


# ---------------------------------------------------------------------------
# Globs: the picomatch subset shared by every tiacore runtime. `*` and `?` stay
# inside one path segment, a whole `**` segment spans zero or more segments,
# `[...]` is a class, `{a,b}` is an alternative and dotfiles match.
# ---------------------------------------------------------------------------


def _expand_braces(pattern: str) -> list[str]:
    start = pattern.find("{")
    if start == -1:
        return [pattern]
    depth = 0
    for index in range(start, len(pattern)):
        if pattern[index] == "{":
            depth += 1
        elif pattern[index] == "}":
            depth -= 1
            if depth == 0:
                break
    else:
        return [pattern]
    inner = pattern[start + 1 : index]
    options: list[str] = []
    depth = 0
    current = ""
    for char in inner:
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        if char == "," and depth == 0:
            options.append(current)
            current = ""
        else:
            current += char
    options.append(current)
    if len(options) == 1:
        return [
            pattern[:start] + "{" + option + "}" + tail
            for option in options
            for tail in _expand_braces(pattern[index + 1 :])
        ]
    expanded: list[str] = []
    for option in options:
        for tail in _expand_braces(pattern[index + 1 :]):
            expanded.extend(
                _expand_braces(pattern[:start] + option + tail)
            )
    return expanded


def _segment_regex(segment: str) -> re.Pattern[str]:
    out = ""
    index = 0
    while index < len(segment):
        char = segment[index]
        if char == "\\" and index + 1 < len(segment):
            out += re.escape(segment[index + 1])
            index += 2
            continue
        if char == "*":
            while index < len(segment) and segment[index] == "*":
                index += 1
            out += "[^/]*"
            continue
        if char == "?":
            out += "[^/]"
        elif char == "[":
            close = segment.find("]", index + 2)
            if close == -1:
                out += re.escape(char)
            else:
                body = segment[index + 1 : close]
                negate = body[:1] in ("!", "^")
                if negate:
                    body = body[1:]
                out += "[" + ("^" if negate else "") + re.sub(
                    r"([\\\[\]^])", r"\\\1", body
                ) + "]"
                index = close
        else:
            out += re.escape(char)
        index += 1
    return re.compile(out, re.DOTALL)


def _match_segments(
    patterns: Sequence[str],
    parts: Sequence[str],
    cache: dict[str, re.Pattern[str]],
) -> bool:
    if not patterns:
        return not parts
    head, rest = patterns[0], patterns[1:]
    if head == "**":
        return any(
            _match_segments(rest, parts[skip:], cache)
            for skip in range(len(parts) + 1)
        )
    if not parts:
        return False
    compiled = cache.get(head)
    if compiled is None:
        compiled = cache[head] = _segment_regex(head)
    return compiled.fullmatch(parts[0]) is not None and _match_segments(
        rest, parts[1:], cache
    )


def glob_matcher(patterns: str | Sequence[str]):
    """Return a predicate matching normalized paths against the glob subset."""
    listed = [patterns] if isinstance(patterns, str) else list(patterns)
    compiled: list[list[str]] = []
    for pattern in listed:
        for expanded in _expand_braces(pattern):
            if expanded.startswith("./"):
                expanded = expanded[2:]
            compiled.append(expanded.split("/"))
    cache: dict[str, re.Pattern[str]] = {}

    def matches(path: str) -> bool:
        parts = path.split("/")
        return any(_match_segments(p, parts, cache) for p in compiled)

    return matches


# ---------------------------------------------------------------------------
# Graph validation and canonical form (mirrors src/wire/protocol.ts).
# ---------------------------------------------------------------------------


class GraphError(ValueError):
    """A stored impact graph does not satisfy protocol v1."""


def _js_blank(value: str) -> bool:
    return value.strip(_JS_WHITESPACE) == ""


def _object(value: Any, label: str, keys: frozenset[str]) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise GraphError(f"{label} Expected object")
    for key in value:
        if key not in keys:
            raise GraphError(f"{label}.{key} has an unknown field")
    return value


def _string(value: Any, label: str, *, blank: bool = False) -> str:
    if not isinstance(value, str):
        raise GraphError(f"{label} Expected string")
    if utf16_length(value) > LIMITS["stringLength"]:
        raise GraphError(f"{label} exceeds the limit of {LIMITS['stringLength']}")
    if not blank and _js_blank(value):
        raise GraphError(f"{label} must not be empty")
    return value


def _path(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise GraphError(f"{label} Expected string")
    try:
        return normalize_path(value)
    except ValueError:
        raise GraphError(f"{label} must be project-relative: {value}") from None


def _array(value: Any, label: str, limit: int) -> list[Any]:
    if not isinstance(value, list):
        raise GraphError(f"{label} Expected array")
    if len(value) > limit:
        raise GraphError(f"{label} exceeds the limit of {limit}")
    return value


def _distinct(values: list[str], label: str) -> list[str]:
    if len(set(values)) != len(values):
        raise GraphError(f"{label} contains duplicate values")
    return values


def _strings(value: Any, label: str, limit: int) -> list[str]:
    items = [
        _string(item, f"{label}[{index}]")
        for index, item in enumerate(_array(value, label, limit))
    ]
    return _distinct(items, label)


_SUITE_KEYS = frozenset(
    {"adapter", "dependsOn", "file", "id", "project", "resourceLocks", "tags"}
)
_OBSERVATION_KEYS = frozenset({"confidence", "kind", "source", "suiteId"})
_INVALIDATOR_KEYS = frozenset({"pattern", "reason"})
_GRAPH_KEYS = frozenset(
    {
        "complete",
        "environmentFingerprint",
        "fingerprint",
        "invalidators",
        "knownSources",
        "observations",
        "protocolVersion",
        "suites",
    }
)


def _required(value: Mapping[str, Any], key: str, label: str) -> Any:
    if key not in value:
        raise GraphError(f"{label} {key} is required")
    return value[key]


def _decode_suite(value: Any, label: str) -> dict[str, Any]:
    raw = _object(value, label, _SUITE_KEYS)
    relation_limit = LIMITS["relationsPerSuite"]
    suite: dict[str, Any] = {
        "adapter": _string(_required(raw, "adapter", label), f"{label}.adapter"),
        "file": _path(_required(raw, "file", label), f"{label}.file"),
        "id": _string(_required(raw, "id", label), f"{label}.id"),
        "project": _string(_required(raw, "project", label), f"{label}.project"),
    }
    for key in ("dependsOn", "resourceLocks", "tags"):
        if key in raw:
            suite[key] = sorted_utf16(
                _strings(raw[key], f"{label}.{key}", relation_limit)
            )
    return suite


def _decode_observation(value: Any, label: str) -> dict[str, str]:
    raw = _object(value, label, _OBSERVATION_KEYS)
    confidence = _required(raw, "confidence", label)
    if confidence not in EDGE_CONFIDENCES:
        raise GraphError(f"{label}.confidence Expected a known confidence")
    kind = _required(raw, "kind", label)
    if kind not in EDGE_KINDS:
        raise GraphError(f"{label}.kind Expected a known edge kind")
    return {
        "confidence": confidence,
        "kind": kind,
        "source": _path(_required(raw, "source", label), f"{label}.source"),
        "suiteId": _string(
            _required(raw, "suiteId", label), f"{label}.suiteId"
        ),
    }


def _observation_key(observation: Mapping[str, str]) -> str:
    return "\0".join(
        (
            observation["suiteId"],
            observation["source"],
            observation["kind"],
            observation["confidence"],
        )
    )


def _invalidator_key(invalidator: Mapping[str, str]) -> str:
    return f"{invalidator['pattern']}\0{invalidator['reason']}"


def _check_suites(
    suites: list[dict[str, Any]], observations: list[dict[str, str]]
) -> None:
    by_id = {suite["id"]: suite for suite in suites}
    for suite in suites:
        for dependency in suite.get("dependsOn", []):
            if dependency not in by_id:
                raise GraphError(
                    f"suite {suite['id']} depends on unknown suite {dependency}"
                )
    visiting: set[str] = set()
    visited: set[str] = set()
    for root in by_id:
        if root in visited:
            continue
        stack = [(root, iter(by_id[root].get("dependsOn", [])))]
        visiting.add(root)
        while stack:
            current, children = stack[-1]
            advanced = False
            for child in children:
                if child in visiting:
                    raise GraphError(
                        f"suite dependency cycle includes {child}"
                    )
                if child in visited:
                    continue
                visiting.add(child)
                stack.append((child, iter(by_id[child].get("dependsOn", []))))
                advanced = True
                break
            if not advanced:
                visiting.discard(current)
                visited.add(current)
                stack.pop()
    for observation in observations:
        if observation["suiteId"] not in by_id:
            raise GraphError(
                f"observation references unknown suite {observation['suiteId']}"
            )


def parse_impact_graph(value: Any) -> dict[str, Any]:
    """Validate a protocol v1 graph and return its canonical form."""
    label = "TIA impact graph"
    raw = _object(value, label, _GRAPH_KEYS)
    version = _required(raw, "protocolVersion", label)
    if isinstance(version, bool) or version != PROTOCOL_VERSION:
        raise GraphError(
            f"{label} protocolVersion is an unsupported TIA protocol version"
        )
    complete = _required(raw, "complete", label)
    if not isinstance(complete, bool):
        raise GraphError(f"{label} complete Expected boolean")
    environment = _string(
        _required(raw, "environmentFingerprint", label),
        f"{label} environmentFingerprint",
        blank=True,
    )
    fingerprint = _string(
        _required(raw, "fingerprint", label), f"{label} fingerprint"
    )

    graph: dict[str, Any] = {
        "complete": complete,
        "environmentFingerprint": environment,
        "fingerprint": fingerprint,
        "protocolVersion": PROTOCOL_VERSION,
    }
    if "invalidators" in raw:
        invalidators = []
        for index, item in enumerate(
            _array(raw["invalidators"], f"{label} invalidators", LIMITS["invalidators"])
        ):
            where = f"{label} invalidators[{index}]"
            entry = _object(item, where, _INVALIDATOR_KEYS)
            invalidators.append(
                {
                    "pattern": _string(
                        _required(entry, "pattern", where), f"{where}.pattern"
                    ),
                    "reason": _string(
                        _required(entry, "reason", where), f"{where}.reason"
                    ),
                }
            )
        _distinct(
            [_invalidator_key(item) for item in invalidators],
            f"{label} invalidators",
        )
        graph["invalidators"] = sorted(
            invalidators, key=lambda item: utf16_key(_invalidator_key(item))
        )
    if "knownSources" in raw:
        sources = [
            _path(item, f"{label} knownSources[{index}]")
            for index, item in enumerate(
                _array(
                    raw["knownSources"],
                    f"{label} knownSources",
                    LIMITS["knownSources"],
                )
            )
        ]
        graph["knownSources"] = sorted_utf16(
            _distinct(sources, f"{label} knownSources")
        )
    observations = [
        _decode_observation(item, f"{label} observations[{index}]")
        for index, item in enumerate(
            _array(
                _required(raw, "observations", label),
                f"{label} observations",
                LIMITS["observations"],
            )
        )
    ]
    _distinct(
        [_observation_key(item) for item in observations],
        f"{label} observations",
    )
    suites = [
        _decode_suite(item, f"{label} suites[{index}]")
        for index, item in enumerate(
            _array(
                _required(raw, "suites", label),
                f"{label} suites",
                LIMITS["suites"],
            )
        )
    ]
    _distinct([suite["id"] for suite in suites], f"{label} suites")
    _check_suites(suites, observations)
    graph["observations"] = sorted(
        observations, key=lambda item: utf16_key(_observation_key(item))
    )
    graph["suites"] = sorted(suites, key=lambda suite: utf16_key(suite["id"]))
    return graph


# ---------------------------------------------------------------------------
# Planning (mirrors src/engine/plan/protocol.ts).
# ---------------------------------------------------------------------------


def _catalog_suites(
    catalog: Sequence[Mapping[str, Any]],
) -> dict[str, Mapping[str, Any]]:
    suites: dict[str, Mapping[str, Any]] = {}
    for suite in catalog:
        suite_id = suite["id"]
        if _js_blank(suite_id) or suite_id in suites:
            raise ValueError(f"duplicate or empty TIA suite id: {suite_id}")
        normalize_path(suite["file"])
        suites[suite_id] = suite
    for suite in catalog:
        for dependency in suite.get("dependsOn", []):
            if dependency not in suites:
                raise ValueError(
                    f"TIA suite {suite['id']} depends on unknown suite "
                    f"{dependency}"
                )
    return suites


def _locks(
    suites: Mapping[str, Mapping[str, Any]], selected: Iterable[str]
) -> list[str]:
    return sorted_unique_utf16(
        lock
        for suite_id in selected
        for lock in suites[suite_id].get("resourceLocks", [])
    )


def _full_plan(
    suites: Mapping[str, Mapping[str, Any]],
    changed_files: list[str],
    reason: str,
) -> dict[str, Any]:
    selected = sorted_utf16(suites)
    return {
        "cached": [],
        "changedFiles": changed_files,
        "mode": "full",
        "protocolVersion": PROTOCOL_VERSION,
        "reason": reason,
        "reasons": {suite_id: [reason] for suite_id in selected},
        "resourceLocks": _locks(suites, selected),
        "selected": selected,
    }


def create_impact_plan(
    *,
    catalog: Sequence[Mapping[str, Any]],
    changes: Sequence[str],
    environment_fingerprint: str,
    fingerprint: str,
    graph: Any,
    force_full: bool = False,
    ignore_changes: Sequence[str] = (),
    on_unknown_change: str = "full",
    allowed_suites: Sequence[str] | None = None,
    expected_fingerprint: str | None = None,
    expected_environment_fingerprint: str | None = None,
) -> dict[str, Any]:
    """Plan which suites of a protocol v1 catalog must run for a change set.

    Raises ValueError for an invalid catalog, policy or changed path. A stored
    graph that is missing, invalid, incomplete or stale yields a full plan.
    """
    suites = _catalog_suites(catalog)
    allowed = set(suites) if allowed_suites is None else set(allowed_suites)
    for suite_id in allowed:
        if suite_id not in suites:
            raise ValueError(f"TIA policy allows unknown suite {suite_id}")
    suites = {k: v for k, v in suites.items() if k in allowed}

    changed_files = sorted_unique_utf16(normalize_path(path) for path in changes)
    if force_full:
        return _full_plan(suites, changed_files, "policy requires a full run")
    if graph is None:
        return _full_plan(
            suites, changed_files, "no compatible impact graph found"
        )
    try:
        stored = parse_impact_graph(graph)
    except GraphError as error:
        return _full_plan(
            suites, changed_files, f"invalid impact graph: {error}"
        )
    if not stored["complete"]:
        return _full_plan(
            suites, changed_files, "the previous impact graph is incomplete"
        )
    if stored["fingerprint"] != fingerprint or (
        expected_fingerprint is not None
        and stored["fingerprint"] != expected_fingerprint
    ):
        return _full_plan(suites, changed_files, "project structure changed")
    if stored["environmentFingerprint"] != environment_fingerprint or (
        expected_environment_fingerprint is not None
        and stored["environmentFingerprint"] != expected_environment_fingerprint
    ):
        return _full_plan(suites, changed_files, "execution environment changed")

    ignored = glob_matcher(list(ignore_changes))
    active = [path for path in changed_files if not ignored(path)]
    invalidators = [
        (item["reason"], glob_matcher(item["pattern"]))
        for item in stored.get("invalidators", [])
    ]
    graph_files = {suite["id"]: suite["file"] for suite in stored["suites"]}
    dependencies: dict[str, set[str]] = {}
    observed_sources: set[str] = set()
    for observation in stored["observations"]:
        dependencies.setdefault(observation["suiteId"], set()).add(
            observation["source"]
        )
        observed_sources.add(observation["source"])
    known = (
        set(stored.get("knownSources", []))
        | observed_sources
        | set(graph_files.values())
    )

    for path in active:
        for reason, matches in invalidators:
            if matches(path):
                return _full_plan(suites, changed_files, f"{reason}: {path}")
        if on_unknown_change == "full" and path not in known:
            return _full_plan(
                suites,
                changed_files,
                f"changed file is unknown to the impact graph: {path}",
            )

    changed = set(active)
    reasons: dict[str, set[str]] = {}
    for suite_id in suites:
        found: set[str] = set()
        file = graph_files.get(suite_id)
        if file is not None and file in changed:
            found.add(f"suite file changed: {file}")
        for source in dependencies.get(suite_id, ()):
            if source in changed:
                found.add(f"observed dependency changed: {source}")
        if found:
            reasons[suite_id] = found

    affected = set(reasons)
    selected = set(affected)
    pending = list(selected)
    while pending:
        current = pending.pop()
        for need in suites[current].get("dependsOn", []):
            if need not in suites:
                continue
            if need not in affected:
                reasons.setdefault(need, set()).add(f"dependency of {current}")
            if need in selected:
                continue
            selected.add(need)
            pending.append(need)

    selected_ids = sorted_utf16(selected)
    count = len(selected_ids)
    return {
        "cached": sorted_utf16(set(suites) - selected),
        "changedFiles": changed_files,
        "mode": "skip" if count == 0 else "selective",
        "protocolVersion": PROTOCOL_VERSION,
        "reason": (
            "no suites are affected"
            if count == 0
            else f"{count} affected suite{'' if count == 1 else 's'}"
        ),
        "reasons": {
            suite_id: sorted_utf16(reasons[suite_id])
            for suite_id in selected_ids
        },
        "resourceLocks": _locks(suites, selected_ids),
        "selected": selected_ids,
    }
