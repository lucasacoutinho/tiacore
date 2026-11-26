from __future__ import annotations

import argparse
import json
import shlex
from dataclasses import replace

from .pytest_adapter import TiaPytestOptions, tia


def main() -> None:
    # Unknown arguments go to pytest, so tiacore flags must never match an
    # abbreviation: pytest's --ignore and --co would read as --ignore-change
    # and --command.
    parser = argparse.ArgumentParser(prog="tiacore-pytest", allow_abbrev=False)
    parser.add_argument("--root", default=".")
    parser.add_argument("--tests", action="append", default=[])
    parser.add_argument("--project", default="pytest")
    parser.add_argument("--change", action="append", default=[])
    parser.add_argument(
        "--ignore-change",
        action="append",
        default=[],
        help="glob of changed files that never select a test; repeatable",
    )
    parser.add_argument(
        "--on-unknown-change",
        choices=("full", "ignore"),
        default="full",
        help="what a change the graph does not know triggers",
    )
    parser.add_argument(
        "--command",
        help="pytest command, split like a POSIX shell (default: this Python -m pytest)",
    )
    parser.add_argument("--environment-fingerprint", required=True)
    parser.add_argument("--graph", default=".tia/pytest/graph.json")
    parser.add_argument("--force-full", action="store_true")
    arguments, pytest_arguments = parser.parse_known_args()
    options = TiaPytestOptions(
        root=arguments.root,
        test_roots=tuple(arguments.tests or ["tests"]),
        project=arguments.project,
        changes=tuple(arguments.change),
        environment_fingerprint=arguments.environment_fingerprint,
        graph_path=arguments.graph,
        command_arguments=tuple(pytest_arguments or ["-q"]),
        force_full=arguments.force_full,
        ignore_changes=tuple(arguments.ignore_change),
        on_unknown_change=arguments.on_unknown_change,
    )
    if arguments.command is not None:
        try:
            command = tuple(shlex.split(arguments.command))
        except ValueError as error:
            parser.error(f"argument --command: {error}")
        if not command:
            parser.error("argument --command: expected a program")
        options = replace(options, command=command)
    result = tia(options).run()
    print(json.dumps(result.plan, sort_keys=True))
    raise SystemExit(result.status)


if __name__ == "__main__":
    main()
