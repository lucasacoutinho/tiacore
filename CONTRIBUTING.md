# Contributing

Thanks for helping improve tiacore. Changes should preserve its core safety
rule: when dependency information is uncertain, expand the test run rather than
skip possibly affected tests.

## Development setup

Use Node 24 for the complete local suite. Install Bun 1.3 and Chromium
(`npx playwright install chromium`) to run the Bun and Playwright suites; they
skip without them. The differential tests compare against the published 1.2.1,
installed as the `tiacore-v1` development dependency.

```sh
npm ci
npm run gate
```

`npm run gate` verifies Oxfmt, runs Oxlint, type-checks with TypeScript 7 and
the Effect language service, runs the test suite and checks the architecture
rules. Use `npm run fmt` and `npm run lint:fix` before committing.

Useful focused commands:

```sh
npm run typecheck
npm run check:architecture
npm run check:package
npm run check:perf     # timing budgets against 1.x, one file at a time
npm run check:proofs   # needs a Lean toolchain (elan)
npm run check:python
npm run check:go
```

Internals follow `docs/architecture/effect-conventions.md`. Public entry points
stay plain TypeScript with Promise APIs: no Effect type reaches a public
declaration file.

## Change expectations

- Add a regression test that executes the real runner or framework path where
  practical. Use component tests for atomic-write, merge, parser, and explicit
  failure-injection boundaries.
- Keep the public entry points to the subpaths `package.json` exports. Do not
  import package internals in consumer examples.
- Store cache paths with project-relative forward slashes.
- Treat cache and artifact input as untrusted: validate before use and fail
  closed on incomplete, conflicting, or corrupt data.
- Do not add standalone maintenance scripts. Put executable verification in a
  test, benchmark, package command, or workflow according to its purpose.
- Update `CHANGELOG.md` and public documentation for user-visible behavior.

## Pull requests

Keep changes scoped and explain the failure mode being addressed. Before
requesting review, run `npm run gate` and `npm run check:package`. Changes to
runtime/version claims must also update the checked-in compatibility matrix.

Publishing, tagging, and dispatching a release remain maintainer-authorized
actions and are never part of an ordinary contribution.
