from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SDK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK_ROOT / "src"))

from tiacore import TiaPytestOptions, tia  # noqa: E402


class PytestAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        environment = mock.patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("TIA_VERIFICATION_DIRECTORY", "TIA_VERIFICATION_PHASE"):
            os.environ.pop(name, None)
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "project"
        shutil.copytree(
            Path(__file__).parent / "fixtures" / "project",
            self.root,
        )
        self.log = self.root / "executions.log"
        self.options = TiaPytestOptions(
            root=str(self.root),
            changes=(),
            environment_fingerprint="python-fixture",
            command=(sys.executable, str(self.root / "fake_pytest.py")),
            command_arguments=(),
            environment={"TIACORE_PYTEST_FIXTURE_LOG": str(self.log)},
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_executes_real_discovered_files_and_reuses_the_graph(self) -> None:
        baseline = tia(self.options).run()
        self.assertTrue(baseline.success)
        self.assertEqual(baseline.plan["mode"], "full")
        self.assertEqual(
            sorted(self.log.read_text(encoding="utf-8").splitlines()),
            ["tests/test_a.py", "tests/test_b.py"],
        )
        graph = json.loads(
            (self.root / ".tia/pytest/graph.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(graph["protocolVersion"], 1)
        a_suite = next(
            suite for suite in graph["suites"] if suite["file"] == "tests/test_a.py"
        )
        a_sources = {
            observation["source"]
            for observation in graph["observations"]
            if observation["suiteId"] == a_suite["id"]
        }
        self.assertIn("src/example/a.py", a_sources)
        self.assertNotIn("src/example/b.py", a_sources)

        self.log.write_text("", encoding="utf-8")
        skipped = tia(self.options).run()
        self.assertEqual(skipped.plan["mode"], "skip")
        self.assertEqual(self.log.read_text(encoding="utf-8"), "")

        affected = tia(
            TiaPytestOptions(
                **{
                    **self.options.__dict__,
                    "changes": ("src/example/a.py",),
                }
            )
        ).run()
        self.assertEqual(affected.plan["mode"], "selective")
        self.assertEqual(
            self.log.read_text(encoding="utf-8"),
            "tests/test_a.py\n",
        )

    def test_unknown_changes_expand_to_the_full_suite(self) -> None:
        self.assertTrue(tia(self.options).run().success)
        self.log.write_text("", encoding="utf-8")
        result = tia(
            TiaPytestOptions(
                **{
                    **self.options.__dict__,
                    "changes": ("src/example/unknown.py",),
                }
            )
        ).run()
        self.assertEqual(result.plan["mode"], "full")
        self.assertEqual(len(self.log.read_text().splitlines()), 2)

    def test_corrupt_graphs_and_windows_paths_fail_safely(self) -> None:
        graph_path = self.root / ".tia/pytest/graph.json"
        graph_path.parent.mkdir(parents=True)
        graph_path.write_text("{broken", encoding="utf-8")
        baseline = tia(self.options).run()
        self.assertEqual(baseline.plan["mode"], "full")

        self.log.write_text("", encoding="utf-8")
        affected = tia(
            TiaPytestOptions(
                **{
                    **self.options.__dict__,
                    "changes": (r"src\example\a.py",),
                }
            )
        ).run()
        self.assertEqual(affected.plan["mode"], "selective")
        self.assertEqual(
            self.log.read_text(encoding="utf-8"),
            "tests/test_a.py\n",
        )


if __name__ == "__main__":
    unittest.main()
