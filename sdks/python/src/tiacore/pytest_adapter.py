from __future__ import annotations

import ast
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

from .protocol import PROTOCOL_VERSION, create_impact_plan

EXCLUDED_DIRECTORIES = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tia",
    ".venv",
    "__pycache__",
    "build",
    "dist",
}


@dataclass(frozen=True)
class TiaPytestOptions:
    root: str = "."
    test_roots: tuple[str, ...] = ("tests",)
    project: str = "pytest"
    changes: tuple[str, ...] = ()
    environment_fingerprint: str = (
        f"python-{sys.version_info.major}.{sys.version_info.minor}-pytest"
    )
    graph_path: str = ".tia/pytest/graph.json"
    command: tuple[str, ...] = field(
        default_factory=lambda: (sys.executable, "-m", "pytest")
    )
    command_arguments: tuple[str, ...] = ("-q",)
    environment: Mapping[str, str] = field(default_factory=dict)
    force_full: bool = False
    ignore_changes: tuple[str, ...] = ()
    on_unknown_change: str = "full"


@dataclass(frozen=True)
class TiaPytestResult:
    plan: dict[str, Any]
    status: int
    success: bool


def _relative(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root).as_posix()


def _python_files(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*.py")
        if not any(part in EXCLUDED_DIRECTORIES for part in path.parts)
    )


def _module_names(root: Path, path: Path) -> set[str]:
    relative = path.relative_to(root)
    variants = [relative]
    if relative.parts and relative.parts[0] == "src":
        variants.append(Path(*relative.parts[1:]))
    names: set[str] = set()
    for variant in variants:
        parts = list(variant.with_suffix("").parts)
        if parts and parts[-1] == "__init__":
            parts.pop()
        if parts:
            names.add(".".join(parts))
    return names


def _module_index(root: Path) -> dict[str, Path]:
    modules: dict[str, Path] = {}
    for path in _python_files(root):
        for name in _module_names(root, path):
            modules.setdefault(name, path)
    return modules


def _imported_modules(path: Path) -> set[str]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError):
        return set()
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                modules.add(node.module)
                modules.update(
                    f"{node.module}.{alias.name}" for alias in node.names
                )
    return modules


def _resolve_module(
    module: str,
    modules: Mapping[str, Path],
) -> Path | None:
    candidate = module
    while candidate:
        path = modules.get(candidate)
        if path is not None:
            return path
        candidate = candidate.rpartition(".")[0]
    return None


def _dependencies(root: Path, test_file: Path) -> list[str]:
    modules = _module_index(root)
    visited: set[Path] = set()
    pending = [test_file]
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        visited.add(path)
        for module in _imported_modules(path):
            imported = _resolve_module(module, modules)
            if imported is not None and imported not in visited:
                pending.append(imported)

    parent = test_file.parent
    while parent == root or root in parent.parents:
        conftest = parent / "conftest.py"
        if conftest.is_file():
            visited.add(conftest)
        if parent == root:
            break
        parent = parent.parent
    return sorted(_relative(root, path) for path in visited)


def discover_pytest_suites(options: TiaPytestOptions) -> list[dict[str, Any]]:
    root = Path(options.root).resolve()
    files: set[Path] = set()
    for test_root in options.test_roots:
        directory = (root / test_root).resolve()
        if root != directory and root not in directory.parents:
            raise ValueError(f"pytest test root escapes project: {test_root}")
        if not directory.is_dir():
            continue
        files.update(directory.rglob("test_*.py"))
        files.update(directory.rglob("*_test.py"))
    return [
        {
            "adapter": "pytest",
            "file": _relative(root, path),
            "id": f"pytest:{options.project}:{_relative(root, path)}",
            "project": options.project,
        }
        for path in sorted(files)
        if not any(part in EXCLUDED_DIRECTORIES for part in path.parts)
    ]


def pytest_catalog_fingerprint(
    root: Path,
    suites: Sequence[dict[str, Any]],
) -> str:
    digest = hashlib.sha256()
    digest.update(
        json.dumps(
            sorted(suites, key=lambda suite: suite["id"]),
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
    )
    for config in ("pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"):
        path = root / config
        if path.is_file():
            digest.update(config.encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def create_pytest_graph(
    options: TiaPytestOptions,
    suites: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    root = Path(options.root).resolve()
    observations = []
    for suite in suites:
        for source in _dependencies(root, root / suite["file"]):
            observations.append(
                {
                    "confidence": "exact",
                    "kind": (
                        "configuration"
                        if source == suite["file"]
                        else "import"
                    ),
                    "source": source,
                    "suiteId": suite["id"],
                }
            )
    return {
        "complete": True,
        "environmentFingerprint": options.environment_fingerprint,
        "fingerprint": pytest_catalog_fingerprint(root, suites),
        "invalidators": [
            {
                "pattern": pattern,
                "reason": "Python test configuration changed",
            }
            for pattern in (
                "pyproject.toml",
                "pytest.ini",
                "setup.cfg",
                "tox.ini",
                "uv.lock",
                "requirements*.txt",
            )
        ],
        "knownSources": [],
        "observations": sorted(
            observations,
            key=lambda item: (item["suiteId"], item["source"], item["kind"]),
        ),
        "protocolVersion": PROTOCOL_VERSION,
        "suites": list(suites),
    }


def _read_graph(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _write_graph(path: Path, graph: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        f"{json.dumps(graph, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


class TiaPytestRunner:
    def __init__(self, options: TiaPytestOptions) -> None:
        self.options = options

    def run(self) -> TiaPytestResult:
        root = Path(self.options.root).resolve()
        graph_path = (root / self.options.graph_path).resolve()
        suites = discover_pytest_suites(self.options)
        fingerprint = pytest_catalog_fingerprint(root, suites)
        graph = _read_graph(graph_path)
        plan = create_impact_plan(
            catalog=suites,
            changes=list(self.options.changes),
            environment_fingerprint=self.options.environment_fingerprint,
            fingerprint=fingerprint,
            graph=graph,
            force_full=self.options.force_full,
            ignore_changes=self.options.ignore_changes,
            on_unknown_change=self.options.on_unknown_change,
        )
        selected = set(plan["selected"])
        files = [
            suite["file"] for suite in suites if suite["id"] in selected
        ]
        status = 0
        if files:
            completed = subprocess.run(
                [
                    *self.options.command,
                    *self.options.command_arguments,
                    *files,
                ],
                cwd=root,
                env={**os.environ, **self.options.environment},
                check=False,
            )
            status = completed.returncode
        if status == 0:
            _write_graph(
                graph_path,
                create_pytest_graph(self.options, suites),
            )
        return TiaPytestResult(
            plan=plan,
            status=status,
            success=status == 0,
        )


def tia(
    options: TiaPytestOptions | None = None,
    **values: Any,
) -> TiaPytestRunner:
    if options is not None and values:
        raise TypeError("pass TiaPytestOptions or keyword options, not both")
    return TiaPytestRunner(options or TiaPytestOptions(**values))
