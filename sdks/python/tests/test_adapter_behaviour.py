from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Mapping
from unittest import mock

SDK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK_ROOT / "src"))

from tiacore import (  # noqa: E402
    TiaPytestOptions,
    create_pytest_graph,
    discover_pytest_suites,
    tia,
)
from tiacore.pytest_adapter import (  # noqa: E402
    _dependencies,
    _read_graph,
    fresh_requested,
)

FAKE_PYTEST = """\
import os, sys
from pathlib import Path
files = [a for a in sys.argv[1:] if a.endswith(".py")]
with Path(os.environ["TIA_LOG"]).open("a", encoding="utf-8") as target:
    target.write("start\\n")
    for file in files:
        target.write(file + "\\n")
sys.exit(int(os.environ.get("TIA_EXIT", "0")))
"""


def write(root: Path, files: Mapping[str, str]) -> None:
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


class ProjectCase(unittest.TestCase):
    files: Mapping[str, str] = {}

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        environment = mock.patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("TIA_VERIFICATION_DIRECTORY", "TIA_VERIFICATION_PHASE"):
            os.environ.pop(name, None)
        self.base = Path(self.temporary.name)
        self.root = self.base / "project"
        write(self.root, {"fake_pytest.py": FAKE_PYTEST, **self.files})
        self.log = self.root / "executions.log"
        self.graph = self.root / ".tia/pytest/graph.json"

    def options(self, **values: object) -> TiaPytestOptions:
        environment = {"TIA_LOG": str(self.log), **values.pop("environment", {})}  # type: ignore[arg-type]
        return TiaPytestOptions(
            **{
                "root": str(self.root),
                "environment_fingerprint": "python-test",
                "command": (sys.executable, str(self.root / "fake_pytest.py")),
                "command_arguments": (),
                "environment": environment,
                **values,
            }  # type: ignore[arg-type]
        )

    def executed(self) -> list[str]:
        if not self.log.exists():
            return []
        return self.log.read_text(encoding="utf-8").splitlines()

    def reset_log(self) -> None:
        self.log.write_text("", encoding="utf-8")


class DiscoveryTests(ProjectCase):
    files = {
        "tests/test_one.py": "def test_one(): pass\n",
        "tests/sub/two_test.py": "def test_two(): pass\n",
        "tests/helper.py": "VALUE = 1\n",
        "tests/__pycache__/test_cached.py": "",
        "tests/build/test_built.py": "",
        "other/test_other.py": "",
    }

    def test_discovers_test_and_suffix_files_sorted_with_posix_ids(self) -> None:
        suites = discover_pytest_suites(self.options(project="demo"))
        self.assertEqual(
            suites,
            [
                {
                    "adapter": "pytest",
                    "file": "tests/sub/two_test.py",
                    "id": "pytest:demo:tests/sub/two_test.py",
                    "project": "demo",
                },
                {
                    "adapter": "pytest",
                    "file": "tests/test_one.py",
                    "id": "pytest:demo:tests/test_one.py",
                    "project": "demo",
                },
            ],
        )

    def test_skips_missing_test_roots_and_rejects_escaping_ones(self) -> None:
        self.assertEqual(
            discover_pytest_suites(self.options(test_roots=("nothing",))), []
        )
        with self.assertRaisesRegex(ValueError, "escapes project"):
            discover_pytest_suites(self.options(test_roots=("../outside",)))

    def test_a_project_below_a_build_or_dist_directory_still_discovers_suites(
        self,
    ) -> None:
        for name in ("build", "dist"):
            with self.subTest(name):
                nested = self.base / name / "checkout"
                write(nested, {"tests/test_x.py": "def test_x(): pass\n"})
                suites = discover_pytest_suites(
                    TiaPytestOptions(root=str(nested))
                )
                self.assertEqual(
                    [suite["file"] for suite in suites], ["tests/test_x.py"]
                )

    def test_a_symlink_pointing_outside_the_root_is_skipped(self) -> None:
        outside = self.base / "outside_test.py"
        outside.write_text("def test_outside(): pass\n", encoding="utf-8")
        try:
            (self.root / "tests/test_link.py").symlink_to(outside)
        except OSError:
            self.skipTest("symlinks unavailable")
        suites = discover_pytest_suites(self.options())
        self.assertNotIn("tests/test_link.py", [s["file"] for s in suites])
        self.assertEqual(len(suites), 2)
        graph = create_pytest_graph(self.options(), suites)
        self.assertTrue(graph["complete"])


class ImportGraphTests(ProjectCase):
    files = {
        "src/pkg/__init__.py": "from .core import value\n",
        "src/pkg/core.py": "from . import helpers\nfrom .sub import leaf\n",
        "src/pkg/helpers.py": "X = 1\n",
        "src/pkg/sub/__init__.py": "",
        "src/pkg/sub/leaf.py": "from .. import helpers\nfrom ..helpers import X\n",
        "src/other.py": "Y = 2\n",
        "src/unused.py": "Z = 3\n",
        "src/broken.py": "def (\n",
        "tests/conftest.py": "import other\n",
        "tests/test_a.py": "import pkg.core\n",
        "tests/test_b.py": "from pkg import sub\n",
        "tests/test_c.py": "import broken\n",
        "tests/inner/conftest.py": "",
        "tests/inner/test_d.py": "from tests_local import nothing\n",
        "conftest.py": "",
    }

    def sources(self, test: str) -> list[str]:
        suites = discover_pytest_suites(self.options())
        graph = create_pytest_graph(self.options(), suites)
        suite = next(item for item in suites if item["file"] == test)
        return [
            observation["source"]
            for observation in graph["observations"]
            if observation["suiteId"] == suite["id"]
        ]

    def test_follows_absolute_and_relative_imports_and_ancestor_conftests(
        self,
    ) -> None:
        self.assertEqual(
            self.sources("tests/test_a.py"),
            [
                "conftest.py",
                "src/pkg/__init__.py",
                "src/pkg/core.py",
                "src/pkg/helpers.py",
                "src/pkg/sub/__init__.py",
                "src/pkg/sub/leaf.py",
                "tests/conftest.py",
                "tests/test_a.py",
            ],
        )

    def test_conftest_imports_are_not_followed_and_nested_conftests_count(
        self,
    ) -> None:
        sources = self.sources("tests/inner/test_d.py")
        self.assertEqual(
            sources,
            [
                "conftest.py",
                "tests/conftest.py",
                "tests/inner/conftest.py",
                "tests/inner/test_d.py",
            ],
        )

    def test_unparseable_modules_contribute_no_imports(self) -> None:
        self.assertEqual(
            self.sources("tests/test_c.py"),
            ["conftest.py", "src/broken.py", "tests/conftest.py", "tests/test_c.py"],
        )

    def test_src_prefixed_and_plain_names_resolve_to_the_first_sorted_file(
        self,
    ) -> None:
        write(self.root, {"pkg/core.py": "# shadow\n"})
        suites = discover_pytest_suites(self.options())
        suite = next(s for s in suites if s["file"] == "tests/test_a.py")
        sources = _dependencies(self.root.resolve(), self.root.resolve() / suite["file"])
        self.assertIn("pkg/core.py", sources)
        self.assertNotIn("src/pkg/core.py", sources)

    def test_kind_marks_the_suite_file_as_configuration(self) -> None:
        suites = discover_pytest_suites(self.options())
        graph = create_pytest_graph(self.options(), suites)
        kinds = {
            (item["source"], item["kind"])
            for item in graph["observations"]
            if item["source"] == "tests/test_a.py"
            or item["source"] == "src/pkg/core.py"
        }
        self.assertEqual(
            kinds,
            {("tests/test_a.py", "configuration"), ("src/pkg/core.py", "import")},
        )
        self.assertTrue(
            all(item["confidence"] == "exact" for item in graph["observations"])
        )


class GraphShapeTests(ProjectCase):
    files = {"tests/test_a.py": "def test_a(): pass\n"}

    def test_graph_carries_the_six_fixed_invalidators_and_no_known_sources(
        self,
    ) -> None:
        graph = create_pytest_graph(self.options(), discover_pytest_suites(self.options()))
        self.assertEqual(graph["protocolVersion"], 1)
        self.assertTrue(graph["complete"])
        self.assertEqual(graph["knownSources"], [])
        self.assertEqual(
            graph["invalidators"],
            [
                {"pattern": pattern, "reason": "Python test configuration changed"}
                for pattern in (
                    "pyproject.toml",
                    "pytest.ini",
                    "setup.cfg",
                    "tox.ini",
                    "uv.lock",
                    "requirements*.txt",
                )
            ],
        )

    def test_non_python_changes_are_unknown_and_force_a_full_run(self) -> None:
        self.assertTrue(tia(self.options()).run().success)
        for change in ("README.md", ".github/ci.yml"):
            with self.subTest(change):
                result = tia(self.options(changes=(change,))).run()
                self.assertEqual(result.plan["mode"], "full")
                self.assertIn("unknown to the impact graph", result.plan["reason"])

    def test_configuration_changes_trip_the_invalidators(self) -> None:
        self.assertTrue(tia(self.options()).run().success)
        for change in ("pyproject.toml", "requirements-dev.txt", "uv.lock"):
            with self.subTest(change):
                result = tia(self.options(changes=(change,))).run()
                self.assertEqual(result.plan["mode"], "full")
                self.assertEqual(
                    result.plan["reason"],
                    f"Python test configuration changed: {change}",
                )

    def test_the_catalog_fingerprint_changes_with_configuration_files(self) -> None:
        self.assertTrue(tia(self.options()).run().success)
        write(self.root, {"pytest.ini": "[pytest]\n"})
        result = tia(self.options()).run()
        self.assertEqual(result.plan["reason"], "project structure changed")


class GraphFileTests(ProjectCase):
    files = {"tests/test_a.py": "def test_a(): pass\n"}

    def seed(self) -> None:
        self.assertTrue(tia(self.options()).run().success)
        self.reset_log()

    def test_unreadable_graphs_are_treated_as_missing(self) -> None:
        for name, content in (
            ("empty", b""),
            ("broken", b"{broken"),
            ("array", b"[]"),
            ("scalar", b"1"),
            ("invalid utf-8", b"\xff\xfe{\xc3\x28"),
        ):
            with self.subTest(name):
                self.seed()
                self.graph.write_bytes(content)
                result = tia(self.options()).run()
                self.assertEqual(result.plan["mode"], "full")
                self.assertEqual(
                    result.plan["reason"], "no compatible impact graph found"
                )
                self.assertEqual(self.executed(), ["start", "tests/test_a.py"])

    def test_a_directory_in_place_of_the_graph_is_treated_as_missing(self) -> None:
        self.graph.mkdir(parents=True)
        self.assertIsNone(_read_graph(self.graph))

    def test_the_graph_is_written_atomically_as_sorted_indented_json(self) -> None:
        self.seed()
        text = self.graph.read_text(encoding="utf-8")
        self.assertTrue(text.endswith("}\n"))
        self.assertEqual(
            text, json.dumps(json.loads(text), indent=2, sort_keys=True) + "\n"
        )
        self.assertEqual(list(self.graph.parent.glob("*.tmp")), [])

    def test_a_structurally_invalid_graph_falls_back_to_a_full_run(self) -> None:
        self.seed()
        graph = json.loads(self.graph.read_text(encoding="utf-8"))
        graph["unsafeSkip"] = True
        self.graph.write_text(json.dumps(graph), encoding="utf-8")
        result = tia(self.options()).run()
        self.assertEqual(result.plan["mode"], "full")
        self.assertTrue(result.plan["reason"].startswith("invalid impact graph"))


class RunTests(ProjectCase):
    files = {
        "src/lib.py": "VALUE = 1\n",
        "tests/test_a.py": "import lib\n",
        "tests/test_b.py": "def test_b(): pass\n",
    }

    def seed(self) -> None:
        self.assertTrue(tia(self.options()).run().success)
        self.reset_log()

    def test_skip_does_not_start_pytest_and_succeeds(self) -> None:
        self.seed()
        result = tia(self.options()).run()
        self.assertEqual((result.plan["mode"], result.status, result.success), ("skip", 0, True))
        self.assertEqual(self.executed(), [])

    def test_selective_runs_only_the_selected_files_in_discovery_order(self) -> None:
        self.seed()
        result = tia(self.options(changes=("src/lib.py",))).run()
        self.assertEqual(result.plan["selected"], ["pytest:pytest:tests/test_a.py"])
        self.assertEqual(self.executed(), ["start", "tests/test_a.py"])

    def test_the_graph_is_rewritten_after_a_skip_run(self) -> None:
        self.seed()
        before = self.graph.stat().st_mtime_ns
        write(self.root, {"tests/test_c.py": "def test_c(): pass\n"})
        self.assertEqual(tia(self.options()).run().plan["mode"], "full")
        self.reset_log()
        self.assertGreaterEqual(self.graph.stat().st_mtime_ns, before)
        self.assertEqual(tia(self.options()).run().plan["mode"], "skip")

    def test_a_failing_pytest_keeps_the_previous_graph_and_status(self) -> None:
        self.seed()
        previous = self.graph.read_bytes()
        result = tia(
            self.options(
                changes=("src/lib.py",), environment={"TIA_EXIT": "3"}
            )
        ).run()
        self.assertEqual((result.status, result.success), (3, False))
        self.assertEqual(self.graph.read_bytes(), previous)

    def test_the_sdk_never_detects_changes_itself(self) -> None:
        self.seed()
        write(self.root, {"src/lib.py": "VALUE = 2\n"})
        self.assertEqual(tia(self.options()).run().plan["mode"], "skip")

    def test_force_full_ignore_changes_and_on_unknown_change(self) -> None:
        self.seed()
        forced = tia(self.options(force_full=True)).run()
        self.assertEqual(forced.plan["reason"], "policy requires a full run")
        self.reset_log()
        ignored = tia(
            self.options(changes=("src/lib.py",), ignore_changes=("src/*.py",))
        ).run()
        self.assertEqual(ignored.plan["mode"], "skip")
        tolerant = tia(
            self.options(changes=("README.md",), on_unknown_change="ignore")
        ).run()
        self.assertEqual(tolerant.plan["mode"], "skip")

    def test_ignore_patterns_filter_changes_before_invalidators_apply(self) -> None:
        self.seed()
        result = tia(
            self.options(changes=("tox.ini",), ignore_changes=("tox.ini",))
        ).run()
        self.assertEqual(result.plan["mode"], "skip")

    def test_the_child_receives_the_environment_overrides_and_root_cwd(self) -> None:
        write(
            self.root,
            {
                "probe.py": "import os, pathlib\n"
                "pathlib.Path(os.environ['TIA_LOG']).write_text("
                "os.getcwd() + '|' + os.environ['TIA_PROBE'])\n"
            },
        )
        tia(
            self.options(
                command=(sys.executable, str(self.root / "probe.py")),
                environment={"TIA_PROBE": "yes"},
            )
        ).run()
        self.assertEqual(
            self.log.read_text(encoding="utf-8"),
            f"{self.root.resolve()}|yes",
        )

    def test_unsafe_change_paths_raise(self) -> None:
        self.seed()
        for change in ("../outside.py", "/etc/passwd", "C:\\x.py", "x/../"):
            with self.subTest(change):
                with self.assertRaises(ValueError):
                    tia(self.options(changes=(change,))).run()


class FreshTests(ProjectCase):
    files = {"tests/test_a.py": "def test_a(): pass\n"}

    def test_fresh_requested_accepts_one_true_yes_on_in_any_case(self) -> None:
        for value in ("1", "true", "TRUE", "True", "yes", "YES", "on", "On"):
            with self.subTest(value):
                self.assertTrue(fresh_requested(value))
        for value in (None, "", "0", "false", "no", "off", " 1", "1 ", "2", "y"):
            with self.subTest(value):
                self.assertFalse(fresh_requested(value))

    def test_tia_fresh_forces_a_full_run(self) -> None:
        self.assertTrue(tia(self.options()).run().success)
        for value in ("1", "true", "YES", "on"):
            with self.subTest(value):
                os.environ["TIA_FRESH"] = value
                try:
                    result = tia(self.options()).run()
                finally:
                    del os.environ["TIA_FRESH"]
                self.assertEqual(result.plan["mode"], "full")
                self.assertEqual(result.plan["reason"], "policy requires a full run")
        os.environ["TIA_FRESH"] = "nope"
        try:
            self.assertEqual(tia(self.options()).run().plan["mode"], "skip")
        finally:
            del os.environ["TIA_FRESH"]


class CommandLineTests(ProjectCase):
    files = {
        "src/lib.py": "VALUE = 1\n",
        "tests/test_a.py": "import lib\n",
        "extra/check_test.py": "",
    }

    def cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        environment = {
            **os.environ,
            "PYTHONPATH": str(SDK_ROOT / "src"),
            "TIA_LOG": str(self.log),
        }
        environment.pop("TIA_FRESH", None)
        return subprocess.run(
            [sys.executable, "-B", "-m", "tiacore", *arguments],
            capture_output=True,
            text=True,
            env=environment,
            check=False,
        )

    def base_arguments(self) -> list[str]:
        return [
            "--root",
            str(self.root),
            "--environment-fingerprint",
            "cli-test",
        ]

    def test_prints_one_sorted_plan_line_last_and_forwards_unknown_arguments(
        self,
    ) -> None:
        # The fake command is `python -m pytest`; give it a module named pytest.
        write(self.root, {"pytest.py": FAKE_PYTEST})
        first = self.cli(*self.base_arguments(), "--tests", "tests", "-x", "-q")
        self.assertEqual(first.returncode, 0, first.stderr)
        lines = first.stdout.splitlines()
        plan = json.loads(lines[-1])
        self.assertEqual(plan["mode"], "full")
        self.assertEqual(lines[-1], json.dumps(plan, sort_keys=True))
        self.assertEqual(self.executed(), ["start", "tests/test_a.py"])

        self.reset_log()
        skipped = self.cli(*self.base_arguments(), "--tests", "tests")
        self.assertEqual(skipped.returncode, 0)
        self.assertEqual(json.loads(skipped.stdout.splitlines()[-1])["mode"], "skip")
        self.assertEqual(self.executed(), [])

        changed = self.cli(
            *self.base_arguments(), "--tests", "tests", "--change", "src/lib.py"
        )
        self.assertEqual(
            json.loads(changed.stdout.splitlines()[-1])["selected"],
            ["pytest:pytest:tests/test_a.py"],
        )

    def test_repeatable_tests_project_graph_and_force_full(self) -> None:
        write(self.root, {"pytest.py": FAKE_PYTEST})
        result = self.cli(
            *self.base_arguments(),
            "--tests",
            "tests",
            "--tests",
            "extra",
            "--project",
            "demo",
            "--graph",
            "custom/graph.json",
            "--force-full",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual(
            plan["selected"],
            ["pytest:demo:extra/check_test.py", "pytest:demo:tests/test_a.py"],
        )
        self.assertTrue((self.root / "custom/graph.json").is_file())

    def test_exits_with_the_pytest_status_and_requires_a_fingerprint(self) -> None:
        write(self.root, {"pytest.py": FAKE_PYTEST})
        failing = subprocess.run(
            [sys.executable, "-B", "-m", "tiacore", *self.base_arguments()],
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "PYTHONPATH": str(SDK_ROOT / "src"),
                "TIA_LOG": str(self.log),
                "TIA_EXIT": "5",
            },
            check=False,
        )
        self.assertEqual(failing.returncode, 5)
        missing = self.cli("--root", str(self.root))
        self.assertEqual(missing.returncode, 2)
        self.assertIn("--environment-fingerprint", missing.stderr)


class CertificationTests(unittest.TestCase):
    def test_the_receipt_source_revision_matches_the_sdk_sources(self) -> None:
        source = SDK_ROOT / "src"
        digest = hashlib.sha256()
        for path in sorted(
            item
            for item in source.rglob("*")
            if item.is_file() and "__pycache__" not in item.parts
        ):
            digest.update(path.relative_to(source).as_posix().encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
        receipt = json.loads(
            (SDK_ROOT / "certification/adapter.json").read_text(encoding="utf-8")
        )
        self.assertEqual(receipt["sourceRevision"], f"sha256:{digest.hexdigest()}")


if __name__ == "__main__":
    unittest.main()
