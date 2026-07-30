from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

SDK_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SDK_ROOT.parents[1]
sys.path.insert(0, str(SDK_ROOT / "src"))

from tiacore.protocol import create_impact_plan  # noqa: E402


class ProtocolVectorTests(unittest.TestCase):
    def test_shared_planning_vectors(self) -> None:
        vectors = json.loads(
            (
                REPOSITORY_ROOT
                / "conformance"
                / "protocol"
                / "v1"
                / "plans.json"
            ).read_text(encoding="utf-8")
        )
        for vector in vectors["vectors"]:
            with self.subTest(vector["name"]):
                self.assertEqual(
                    create_impact_plan(
                        catalog=vectors["catalog"],
                        changes=vector["changes"],
                        environment_fingerprint=vector[
                            "environmentFingerprint"
                        ],
                        fingerprint=vector["fingerprint"],
                        graph=vectors["graph"],
                    ),
                    vector["expected"],
                )


if __name__ == "__main__":
    unittest.main()
