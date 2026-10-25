from __future__ import annotations

import argparse
import json

from .pytest_adapter import TiaPytestOptions, tia


def main() -> None:
    parser = argparse.ArgumentParser(prog="tiacore-pytest")
    parser.add_argument("--root", default=".")
    parser.add_argument("--tests", action="append", default=[])
    parser.add_argument("--project", default="pytest")
    parser.add_argument("--change", action="append", default=[])
    parser.add_argument("--environment-fingerprint", required=True)
    parser.add_argument("--graph", default=".tia/pytest/graph.json")
    parser.add_argument("--force-full", action="store_true")
    arguments, pytest_arguments = parser.parse_known_args()
    result = tia(
        TiaPytestOptions(
            root=arguments.root,
            test_roots=tuple(arguments.tests or ["tests"]),
            project=arguments.project,
            changes=tuple(arguments.change),
            environment_fingerprint=arguments.environment_fingerprint,
            graph_path=arguments.graph,
            command_arguments=tuple(pytest_arguments or ["-q"]),
            force_full=arguments.force_full,
        )
    ).run()
    print(json.dumps(result.plan, sort_keys=True))
    raise SystemExit(result.status)


if __name__ == "__main__":
    main()
