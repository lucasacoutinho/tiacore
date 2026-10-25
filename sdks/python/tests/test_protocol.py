from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any

SDK_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SDK_ROOT.parents[1]
VECTORS = REPOSITORY_ROOT / "conformance" / "protocol" / "v1"
sys.path.insert(0, str(SDK_ROOT / "src"))

from tiacore.protocol import (  # noqa: E402
    GraphError,
    create_impact_plan,
    glob_matcher,
    normalize_path,
    parse_impact_graph,
    sorted_utf16,
)


def load(name: str) -> Any:
    return json.loads((VECTORS / name).read_text(encoding="utf-8"))


def plan_for(catalog: list[dict[str, Any]], vector: dict[str, Any]) -> dict:
    policy = vector.get("policy") or {}
    return create_impact_plan(
        catalog=catalog,
        changes=vector["changes"],
        environment_fingerprint=vector["environmentFingerprint"],
        fingerprint=vector["fingerprint"],
        graph=vector["graph"],
        force_full=policy.get("forceFull", False),
        ignore_changes=tuple(policy.get("ignoreChanges", ())),
        on_unknown_change=policy.get("onUnknownChange", "full"),
        allowed_suites=policy.get("allowedSuites"),
        expected_fingerprint=policy.get("expectedFingerprint"),
        expected_environment_fingerprint=policy.get(
            "expectedEnvironmentFingerprint"
        ),
    )


class ProtocolVectorTests(unittest.TestCase):
    def test_shared_planning_vectors(self) -> None:
        vectors = load("plans.json")
        for vector in vectors["vectors"]:
            with self.subTest(vector["name"]):
                self.assertEqual(
                    plan_for(
                        vectors["catalog"],
                        {**vector, "graph": vectors["graph"]},
                    ),
                    vector["expected"],
                )

    def test_generated_planning_vectors(self) -> None:
        vectors = load("generated-plans.json")
        self.assertGreaterEqual(len(vectors["cases"]), 300)
        for case in vectors["cases"]:
            with self.subTest(case["name"]):
                if case.get("expectedError"):
                    with self.assertRaises(ValueError):
                        plan_for(case["catalog"], case)
                    continue
                actual = plan_for(case["catalog"], case)
                expected = case["expected"]
                prefix = case.get("expectedReasonPrefix")
                if prefix is not None:
                    self.assertTrue(actual["reason"].startswith(prefix))
                    expected = {
                        **expected,
                        "reason": actual["reason"],
                        "reasons": {
                            suite_id: [actual["reason"]]
                            for suite_id in expected["reasons"]
                        },
                    }
                self.assertEqual(actual, expected)

    def test_invalid_graph_vectors(self) -> None:
        for vector in load("invalid-graphs.json")["vectors"]:
            with self.subTest(vector["name"]):
                with self.assertRaises(GraphError) as raised:
                    parse_impact_graph(vector["graph"])
                self.assertIn(vector["errorIncludes"], str(raised.exception))

    def test_canonicalization_vector(self) -> None:
        vector = load("canonicalization.json")
        self.assertEqual(parse_impact_graph(vector["input"]), vector["expected"])


class NormalizePathTests(unittest.TestCase):
    def test_cleans_separators_dots_and_trailing_slashes(self) -> None:
        self.assertEqual(normalize_path("./a//b\\c/"), "a/b/c")
        self.assertEqual(normalize_path("a/"), "a")
        self.assertEqual(normalize_path("a/./b/../c"), "a/c")

    def test_rejects_unsafe_paths(self) -> None:
        for value in (
            "",
            ".",
            "x/../",
            "../a",
            "a/../../b",
            "/abs",
            "C:\\a",
            "https://example.test/a",
            "a\x00b",
            "a" * 4097,
        ):
            with self.subTest(value[:20]):
                with self.assertRaises(ValueError):
                    normalize_path(value)

    def test_accepts_colons_after_the_first_segment(self) -> None:
        self.assertEqual(normalize_path("a/b://c"), "a/b:/c")


class OrderingAndGlobTests(unittest.TestCase):
    def test_orders_by_utf16_code_unit_not_code_point(self) -> None:
        self.assertEqual(
            sorted_utf16(["\U0001f600", "\uff21"]), ["\U0001f600", "\uff21"]
        )
        self.assertEqual(sorted(["\U0001f600", "\uff21"]), ["\uff21", "\U0001f600"])

    def test_glob_subset_follows_picomatch(self) -> None:
        cases = [
            ("a/**", "a", True),
            ("a/**", "a/b/c", True),
            ("a/**", "ab/c", False),
            ("**/x.ts", "x.ts", True),
            ("**/x.ts", "a/x.ts", True),
            ("*.ts", "a/x.ts", False),
            ("*.ts", ".x.ts", True),
            ("a/*", "a/b/c", False),
            ("a/**/c", "a/c", True),
            ("**a", "x/a", False),
            ("?", "/", False),
            ("requirements*.txt", "requirements.txt", True),
            ("{a,b}.ts", "b.ts", True),
            ("[ab].ts", "c.ts", False),
        ]
        for pattern, path, expected in cases:
            with self.subTest(f"{pattern} {path}"):
                self.assertEqual(glob_matcher(pattern)(path), expected)


if __name__ == "__main__":
    unittest.main()
