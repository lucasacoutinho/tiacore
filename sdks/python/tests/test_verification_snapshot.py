from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Sequence
from unittest import mock

SDK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK_ROOT / "src"))

from tiacore import (  # noqa: E402
    TiaPytestOptions,
    create_pytest_graph,
    discover_pytest_suites,
    tia,
)
from tiacore.verification import (  # noqa: E402
    VerificationTarget,
    verification_target,
    write_snapshot,
)

A = "pytest:pytest:tests/test_a.py"
B = "pytest:pytest:tests/test_b.py"
RUNNER = "pytest:.tia/pytest/graph.json"
MISCONFIGURED = (
    "TIA_VERIFICATION_DIRECTORY and TIA_VERIFICATION_PHASE must be set together"
)


def case(classname: str, outcome: str, name: str = "test_x") -> list[str]:
    return [classname, name, outcome]


def snapshot_file(runner: str, fingerprint: str) -> str:
    digest = hashlib.sha256(f"{runner}\0{fingerprint}".encode()).hexdigest()
    return f"{digest}.json"


class SnapshotCase(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "project"
        shutil.copytree(Path(__file__).parent / "fixtures" / "project", self.root)
        self.log = self.root / "executions.log"
        self.argv_log = self.root / "argv.log"
        self.directory = self.base / "verification"
        self.graph_file = self.root / ".tia/pytest/graph.json"
        patcher = mock.patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in (
            "TIA_FRESH",
            "TIA_VERIFICATION_DIRECTORY",
            "TIA_VERIFICATION_PHASE",
        ):
            os.environ.pop(name, None)

    def options(
        self,
        *,
        exit_status: int = 0,
        cases: Sequence[Sequence[str]] | None = None,
        report: str | None = None,
        **values: Any,
    ) -> TiaPytestOptions:
        environment = {
            "TIACORE_PYTEST_FIXTURE_LOG": str(self.log),
            "TIACORE_PYTEST_FIXTURE_ARGV": str(self.argv_log),
            "TIACORE_PYTEST_FIXTURE_EXIT": str(exit_status),
        }
        if cases is not None:
            environment["TIACORE_PYTEST_FIXTURE_OUTCOMES"] = json.dumps(cases)
        if report is not None:
            environment["TIACORE_PYTEST_FIXTURE_REPORT"] = report
        return TiaPytestOptions(
            **{
                "root": str(self.root),
                "environment_fingerprint": "python-fixture",
                "command": (sys.executable, str(self.root / "fake_pytest.py")),
                "command_arguments": ("-q",),
                "environment": environment,
                **values,
            }
        )

    def run_for(self, phase: str | None, **values: Any) -> Any:
        """Run the adapter, as `tiacore verify` would for `phase`; with no
        phase, as a plain run with no verification target."""
        if phase is not None:
            os.environ["TIA_VERIFICATION_DIRECTORY"] = str(self.directory)
            os.environ["TIA_VERIFICATION_PHASE"] = phase
        try:
            return tia(self.options(**values)).run()
        finally:
            os.environ.pop("TIA_VERIFICATION_DIRECTORY", None)
            os.environ.pop("TIA_VERIFICATION_PHASE", None)

    def seed(self) -> None:
        """A baseline full run with no target, so the graph is promoted."""
        self.assertTrue(self.run_for(None).success)
        self.log.write_text("", encoding="utf-8")
        self.argv_log.write_text("", encoding="utf-8")

    def invocations(self) -> list[list[str]]:
        if not self.argv_log.exists():
            return []
        return [
            json.loads(line)
            for line in self.argv_log.read_text(encoding="utf-8").splitlines()
        ]

    def snapshot(self, phase: str) -> dict[str, Any]:
        files = list((self.directory / phase).glob("*.json"))
        self.assertEqual(len(files), 1, files)
        return json.loads(files[0].read_text(encoding="utf-8"))

    def outcomes(
        self, status: int, cases: Sequence[Sequence[str]] | None, **values: Any
    ) -> dict[str, str]:
        """The suite outcomes of a full run that ends with `status`."""
        self.run_for("full", exit_status=status, cases=cases, **values)
        return self.snapshot("full")["suiteOutcomes"]


class NoTargetTests(SnapshotCase):
    def test_a_plain_run_writes_nothing_and_adds_no_argument(self) -> None:
        result = self.run_for(None)
        self.assertTrue(result.success)
        self.assertFalse(self.directory.exists())
        self.assertEqual(
            self.invocations(), [["-q", "tests/test_a.py", "tests/test_b.py"]]
        )
        self.assertEqual(
            sorted(
                path.relative_to(self.root).as_posix()
                for path in self.root.rglob("*")
                if path.is_file() and ".tia" in path.parts
            ),
            [".tia/pytest/graph.json"],
        )

    def test_a_failing_plain_run_adds_no_argument_and_builds_no_graph(self) -> None:
        with mock.patch(
            "tiacore.pytest_adapter.create_pytest_graph",
            side_effect=AssertionError("no graph for a failed plain run"),
        ):
            result = self.run_for(None, exit_status=1)
        self.assertEqual((result.status, result.success), (1, False))
        self.assertEqual(
            self.invocations(), [["-q", "tests/test_a.py", "tests/test_b.py"]]
        )
        self.assertFalse(self.graph_file.exists())

    def test_no_target_is_none(self) -> None:
        self.assertIsNone(verification_target({}))


class SnapshotWriteTests(SnapshotCase):
    def test_a_selective_run_writes_the_protocol_snapshot(self) -> None:
        self.seed()
        result = self.run_for(
            "selective",
            changes=("src/example/a.py",),
            cases=[case("tests.test_a", "passed")],
        )
        self.assertEqual(result.plan["mode"], "selective")
        graph = json.loads(self.graph_file.read_text(encoding="utf-8"))
        name = snapshot_file(RUNNER, graph["fingerprint"])
        path = self.directory / "selective" / name
        self.assertEqual(list(path.parent.iterdir()), [path])
        snapshot = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(
            set(snapshot),
            {
                "executedTestIds",
                "generatedAt",
                "graph",
                "kind",
                "phase",
                "plan",
                "runner",
                "schema",
                "success",
                "suiteOutcomes",
            },
        )
        self.assertEqual(snapshot["kind"], "protocol")
        self.assertEqual(snapshot["schema"], 1)
        self.assertEqual(snapshot["phase"], "selective")
        self.assertEqual(snapshot["runner"], RUNNER)
        self.assertRegex(
            snapshot["generatedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$"
        )
        self.assertIs(snapshot["success"], True)
        self.assertEqual(snapshot["executedTestIds"], [A])
        self.assertEqual(snapshot["suiteOutcomes"], {A: "passed"})
        self.assertEqual(snapshot["plan"], result.plan)
        self.assertEqual(
            set(snapshot["plan"]),
            {
                "cached",
                "changedFiles",
                "mode",
                "protocolVersion",
                "reason",
                "reasons",
                "resourceLocks",
                "selected",
            },
        )
        self.assertEqual(snapshot["graph"], graph)

    def test_the_pytest_command_gets_one_temporary_report_before_the_files(
        self,
    ) -> None:
        self.run_for("full")
        (arguments,) = self.invocations()
        self.assertEqual(arguments[0], "-q")
        self.assertRegex(arguments[1], r"^--junitxml=.+\.xml$")
        self.assertEqual(arguments[2:], ["tests/test_a.py", "tests/test_b.py"])
        report = Path(arguments[1].partition("=")[2])
        self.assertFalse(report.exists())
        self.assertFalse(report.parent.exists())

    def test_the_full_run_exits_zero_with_every_suite_passed(self) -> None:
        result = self.run_for("full")
        self.assertEqual(result.plan["mode"], "full")
        snapshot = self.snapshot("full")
        self.assertEqual(snapshot["phase"], "full")
        self.assertEqual(snapshot["executedTestIds"], [A, B])
        self.assertEqual(snapshot["suiteOutcomes"], {A: "passed", B: "passed"})
        self.assertIs(snapshot["success"], True)
        self.assertFalse((self.directory / "selective").exists())

    def test_an_exit_zero_run_passes_everything_whatever_the_report_says(
        self,
    ) -> None:
        self.assertEqual(
            self.outcomes(0, [case("tests.test_a", "failed")]),
            {A: "passed", B: "passed"},
        )

    def test_a_skip_plan_writes_an_empty_execution(self) -> None:
        self.seed()
        result = self.run_for("selective")
        self.assertEqual(result.plan["mode"], "skip")
        self.assertEqual(self.invocations(), [])
        snapshot = self.snapshot("selective")
        self.assertEqual(snapshot["plan"]["mode"], "skip")
        self.assertEqual(snapshot["executedTestIds"], [])
        self.assertEqual(snapshot["suiteOutcomes"], {})
        self.assertIs(snapshot["success"], True)

    def test_the_file_name_is_the_digest_of_the_runner_and_the_fingerprint(
        self,
    ) -> None:
        self.run_for("full")
        (path,) = (self.directory / "full").iterdir()
        graph = json.loads(self.graph_file.read_text(encoding="utf-8"))
        self.assertEqual(path.name, snapshot_file(RUNNER, graph["fingerprint"]))
        self.assertEqual(
            path.name,
            hashlib.sha256(
                b"pytest:.tia/pytest/graph.json\0" + graph["fingerprint"].encode()
            ).hexdigest()
            + ".json",
        )

    def test_the_runner_names_the_graph_file_relative_to_the_root(self) -> None:
        self.run_for("full", graph_path="custom/lane one/graph.json")
        snapshot = self.snapshot("full")
        self.assertEqual(snapshot["runner"], "pytest:custom/lane one/graph.json")
        name = snapshot_file(snapshot["runner"], snapshot["graph"]["fingerprint"])
        self.assertTrue((self.directory / "full" / name).is_file())

    def test_two_lanes_of_one_command_keep_apart(self) -> None:
        self.run_for("full", graph_path=".tia/one.json")
        self.run_for("full", graph_path=".tia/two.json")
        files = sorted((self.directory / "full").iterdir())
        self.assertEqual(len(files), 2)
        runners = {
            json.loads(path.read_text(encoding="utf-8"))["runner"] for path in files
        }
        self.assertEqual(runners, {"pytest:.tia/one.json", "pytest:.tia/two.json"})

    def test_the_snapshot_is_written_atomically(self) -> None:
        self.run_for("full")
        self.assertEqual(list((self.directory / "full").glob("*.tmp")), [])

        with mock.patch(
            "tiacore.verification.os.replace", side_effect=OSError("disk gone")
        ):
            with self.assertRaises(OSError):
                self.run_for("full")
        self.assertEqual(list((self.directory / "full").glob("*.tmp")), [])

    def test_the_executed_ids_sort_by_utf16_code_unit(self) -> None:
        astral, bmp = "suite-\U0001f600", "suite-\uffff"
        self.assertLess(bmp, astral)
        path = write_snapshot(
            VerificationTarget(self.directory, "full"),
            runner=RUNNER,
            plan={"mode": "full"},
            graph={"fingerprint": "abc"},
            outcomes={bmp: "passed", astral: "passed"},
            success=True,
        )
        written = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(written["executedTestIds"], [astral, bmp])

    def test_a_graph_that_cannot_be_built_for_a_failed_run_costs_only_the_snapshot(
        self,
    ) -> None:
        with mock.patch(
            "tiacore.pytest_adapter.create_pytest_graph",
            side_effect=OSError("unreadable"),
        ):
            result = self.run_for("full", exit_status=1)
        self.assertEqual((result.status, result.success), (1, False))
        self.assertFalse(self.directory.exists())


class FailureOutcomeTests(SnapshotCase):
    def test_a_failing_run_attributes_failures_and_still_snapshots_the_graph(
        self,
    ) -> None:
        result = self.run_for(
            "full",
            exit_status=1,
            cases=[
                case("tests.test_a", "passed", "test_one"),
                case("tests.test_a.TestThing", "failed", "test_two"),
                case("tests.test_b", "passed"),
            ],
        )
        self.assertEqual((result.status, result.success), (1, False))
        snapshot = self.snapshot("full")
        self.assertEqual(snapshot["suiteOutcomes"], {A: "failed", B: "passed"})
        self.assertEqual(snapshot["executedTestIds"], [A, B])
        self.assertIs(snapshot["success"], False)
        suites = discover_pytest_suites(self.options())
        self.assertEqual(snapshot["graph"], create_pytest_graph(self.options(), suites))
        self.assertFalse(self.graph_file.exists())

    def test_a_failing_run_keeps_the_previous_graph(self) -> None:
        self.seed()
        previous = self.graph_file.read_bytes()
        self.run_for(
            "selective",
            changes=("src/example/a.py",),
            exit_status=1,
            cases=[case("tests.test_a", "failed")],
        )
        self.assertEqual(self.graph_file.read_bytes(), previous)
        self.assertEqual(self.snapshot("selective")["suiteOutcomes"], {A: "failed"})

    def test_an_erroring_testcase_fails_its_suite(self) -> None:
        self.assertEqual(
            self.outcomes(
                1, [case("tests.test_a", "error"), case("tests.test_b", "passed")]
            ),
            {A: "failed", B: "passed"},
        )

    def test_a_skipped_testcase_does_not_fail_its_suite(self) -> None:
        self.assertEqual(
            self.outcomes(
                1,
                [
                    case("tests.test_a", "skipped"),
                    case("tests.test_b", "failed"),
                ],
            ),
            {A: "passed", B: "failed"},
        )

    def test_a_suite_without_a_testcase_is_unknown(self) -> None:
        self.assertEqual(
            self.outcomes(1, [case("tests.test_a", "failed")]),
            {A: "failed", B: "unknown"},
        )

    def test_a_failure_nothing_owns_leaves_every_suite_unknown(self) -> None:
        for name, classname in (
            ("another module", "tests.test_elsewhere"),
            ("a longer module name", "tests.test_ab"),
            ("a different rootdir", "project.tests.test_a"),
            ("a collection error", ""),
        ):
            with self.subTest(name):
                self.assertEqual(
                    self.outcomes(
                        1,
                        [
                            case("tests.test_a", "passed"),
                            case("tests.test_b", "passed"),
                            case(classname, "error"),
                        ],
                    ),
                    {A: "unknown", B: "unknown"},
                )

    def test_a_passing_testcase_nothing_owns_is_ignored(self) -> None:
        self.assertEqual(
            self.outcomes(
                1, [case("elsewhere", "passed"), case("tests.test_b", "failed")]
            ),
            {A: "unknown", B: "failed"},
        )

    def test_a_status_other_than_zero_or_one_leaves_every_suite_unknown(self) -> None:
        for status in (2, 3, 4, 5, 137):
            with self.subTest(status):
                self.assertEqual(
                    self.outcomes(
                        status,
                        [
                            case("tests.test_a", "passed"),
                            case("tests.test_b", "failed"),
                        ],
                    ),
                    {A: "unknown", B: "unknown"},
                )
                self.assertIs(self.snapshot("full")["success"], False)

    def test_a_report_that_cannot_be_read_leaves_every_suite_unknown(self) -> None:
        unknown = {A: "unknown", B: "unknown"}
        self.assertEqual(self.outcomes(1, None), unknown)
        self.assertEqual(self.outcomes(1, None, report=""), unknown)
        truncated = "<testsuites><testcase"
        self.assertEqual(self.outcomes(1, None, report=truncated), unknown)

    def test_a_failed_run_with_no_failure_in_its_report_is_unknown(self) -> None:
        self.assertEqual(
            self.outcomes(
                1, [case("tests.test_a", "passed"), case("tests.test_b", "passed")]
            ),
            {A: "unknown", B: "unknown"},
        )

    def test_a_bare_testsuite_report_is_read_too(self) -> None:
        report = (
            '<testsuite name="pytest">'
            '<testcase classname="tests.test_b" name="test_b">'
            '<failure message="x"/></testcase>'
            '<testcase classname="tests.test_a" name="test_a"/>'
            "</testsuite>"
        )
        self.assertEqual(
            self.outcomes(1, None, report=report), {A: "passed", B: "failed"}
        )

    def test_nested_and_ambiguous_modules_are_attributed_conservatively(self) -> None:
        for name, content in {
            "tests/sub/test_c.py": "def test_c(): pass\n",
            "tests/test_b/test_d.py": "def test_d(): pass\n",
        }.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        c = "pytest:pytest:tests/sub/test_c.py"
        d = "pytest:pytest:tests/test_b/test_d.py"
        outcomes = self.outcomes(
            1,
            [
                case("tests.sub.test_c.TestC", "failed"),
                case("tests.test_a", "passed"),
                case("tests.test_b.test_d", "passed"),
            ],
        )
        self.assertEqual(
            outcomes, {A: "passed", B: "unknown", c: "failed", d: "unknown"}
        )
        self.assertEqual(
            self.outcomes(1, [case("tests.test_b.test_d", "failed")]),
            {A: "unknown", B: "unknown", c: "unknown", d: "unknown"},
        )


class MisconfigurationTests(SnapshotCase):
    def refuses(self, message: str, **environment: str) -> None:
        os.environ.update(environment)
        # A test root outside the project would raise during discovery, so the
        # message proves the environment is read first.
        options = self.options(test_roots=("../outside",))
        with self.assertRaisesRegex(ValueError, f"^{re.escape(message)}$"):
            tia(options).run()
        self.assertFalse(self.log.exists())
        self.assertEqual(self.invocations(), [])
        self.assertFalse(self.directory.exists())
        self.assertFalse(self.graph_file.exists())

    def test_a_directory_without_a_phase_fails_before_anything_runs(self) -> None:
        self.refuses(MISCONFIGURED, TIA_VERIFICATION_DIRECTORY=str(self.directory))

    def test_a_phase_without_a_directory_fails_before_anything_runs(self) -> None:
        self.refuses(MISCONFIGURED, TIA_VERIFICATION_PHASE="selective")

    def test_a_phase_that_is_neither_selective_nor_full_fails(self) -> None:
        for phase in ("partial", "", "Full"):
            with self.subTest(phase):
                self.refuses(
                    "TIA_VERIFICATION_PHASE must be selective or full",
                    TIA_VERIFICATION_DIRECTORY=str(self.directory),
                    TIA_VERIFICATION_PHASE=phase,
                )

    def test_an_empty_directory_counts_as_set(self) -> None:
        self.assertEqual(
            verification_target(
                {"TIA_VERIFICATION_DIRECTORY": "", "TIA_VERIFICATION_PHASE": "full"}
            ),
            VerificationTarget(Path(""), "full"),
        )

    def test_the_options_environment_is_not_the_verification_environment(self) -> None:
        options = self.options(
            environment={
                "TIACORE_PYTEST_FIXTURE_LOG": str(self.log),
                "TIA_VERIFICATION_DIRECTORY": str(self.directory),
                "TIA_VERIFICATION_PHASE": "full",
            }
        )
        self.assertTrue(tia(options).run().success)
        self.assertFalse(self.directory.exists())


if __name__ == "__main__":
    unittest.main()
