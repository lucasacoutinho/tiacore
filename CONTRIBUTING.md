# Contributing

Thanks for helping improve tiacore. Changes should preserve its core safety
rule: when dependency information is uncertain, expand the test run rather than
skip possibly affected tests.

## Development setup

Use Node 24 for the complete local suite and install Bun 1.3 when changing the
Bun adapter:

```sh
npm ci
npm run check
```

`npm run check` verifies Oxfmt, runs Oxlint, type-checks the repository, and
executes the test suite. Use `npm run fmt` and `npm run lint:fix` before
committing.

Useful focused commands:

```sh
npm run typecheck
npm run fmt:check
npm run lint
npm run test:cross-platform
npm run check:package
npm run benchmark:parallel
```

The benchmark is informational; correctness tests decide acceptance. The
compatibility workflow exercises Node 20/22/24, Vite 6/7/8, Vitest 4.1, Bun 1.3,
npm, pnpm, Yarn Plug'n'Play, and Bun installs.

## Change expectations

- Add a regression test that executes the real runner or framework path where
  practical. Use component tests for atomic-write, merge, parser, and explicit
  failure-injection boundaries.
- Keep stable entry points limited to `@usescherie/tiacore`,
  `@usescherie/tiacore/node`, `@usescherie/tiacore/bun`, and
  `@usescherie/tiacore/core`. Do not import package internals in consumer
  examples.
- Store cache paths with project-relative forward slashes.
- Treat cache and artifact input as untrusted: validate before use and fail
  closed on incomplete, conflicting, or corrupt data.
- Do not add standalone maintenance scripts. Put executable verification in a
  test, benchmark, package command, or workflow according to its purpose.
- Update `CHANGELOG.md` and public documentation for user-visible behavior.

## Pull requests

Keep changes scoped and explain the failure mode being addressed. Before
requesting review, run `npm run check` and `npm run check:package`. Changes to
runtime/version claims must also update the checked-in compatibility matrix.

Publishing, tagging, and dispatching a release remain maintainer-authorized
actions and are never part of an ordinary contribution.
