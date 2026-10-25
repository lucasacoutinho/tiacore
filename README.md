# tiacore

Run the tests a change can affect. Reuse verified results for the rest.

tiacore records runtime dependencies and test outcomes during a full run. On the
next run, it compares the current project with that baseline, executes the
affected tests, and reuses unaffected results. Uncertain input causes a safe
full-suite run.

It supports Vitest, Playwright, `node:test`, `bun:test`, Maestro, k6,
Gradle/JUnit, pytest, and Go's native test runner. Git improves baseline
comparison, but it is optional.

tiacore is licensed under Apache-2.0. Version 2.0 keeps every 1.x package entry
point. It is ESM only and needs Node.js 22.12 or newer. If you use 1.x, read
[Upgrade from 1.x](#upgrade-from-1x) first.

## Quick start

tiacore needs Node.js `^22.12.0 || >=24.0.0`. Install it from npm:

```sh
npm install -D @lucasacoutinho/tiacore
```

Add the Vitest plugin:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { tia } from '@lucasacoutinho/tiacore/vitest'

export default defineConfig({
  plugins: [tia()],
  test: {
    include: ['src/**/*.test.ts'],
  },
})
```

Keep the local graph out of source control:

```gitignore
.tia/
```

Run Vitest normally:

```sh
npx vitest run
```

The first run records a full baseline. Later runs select affected test cases,
rerun cached failures, and reconstruct complete coverage from fresh and cached
per-test shards. No separate `:tia` script is required.

[Read the setup guide](docs/guides/getting-started.md) for Playwright,
`node:test`, Bun, Maestro, k6, pytest, and workspace orchestration.

Before trusting a new adapter or framework edge, compare its selective result
with a fresh full run of the same command:

```sh
npx tiacore verify --output .tia/verification.json -- npm test
```

The command fails when selection misses a required test or when outcomes,
dependency evidence, or complete coverage evidence diverge. It can verify a
workspace command that invokes several TIA runners in one pass.

## Why tiacore

- Runtime evidence catches lazy imports, rendered React components, browser
  chunks, CSS, JSON, SVG, and other dependencies that static import scans miss.
- Cached failures always rerun. Missing, corrupt, or incompatible evidence
  expands selection to the full suite.
- Each runner keeps its native workers, projects, retries, and output.
- Git, filesystem snapshots, worktrees, CI artifacts, and parallel shards use
  the same baseline model.
- Complete Istanbul reports and thresholds survive partial test execution.
- A versioned protocol and conformance suite support adapters outside
  JavaScript.
- `tiacore doctor` checks the install. `tiacore devtools`, OTLP export, and
  trace and metrics files show where a run spends its time. See
  [Observability](docs/observability.md).

The documented package entry points and versioned contracts follow Semantic
Versioning. Internal cache storage may rebuild safely between releases, but it
is never treated as portable application data.

## Supported runners

| Runner       | Import                               | Selection                                                               |
| ------------ | ------------------------------------ | ----------------------------------------------------------------------- |
| Vitest       | `@lucasacoutinho/tiacore/vitest`     | Exact test cases; conservative whole-file handling for concurrent cases |
| Playwright   | `@lucasacoutinho/tiacore/playwright` | Affected spec files from browser and fixture evidence                   |
| `node:test`  | `@lucasacoutinho/tiacore/node`       | Test cases, with precise discovery on Node 22.15 and newer              |
| `bun:test`   | `@lucasacoutinho/tiacore/bun`        | Test cases from isolated LCOV observations                              |
| Maestro      | `@lucasacoutinho/tiacore/maestro`    | Flows and transitive `runFlow` dependencies                             |
| k6           | `@lucasacoutinho/tiacore/k6`         | Profiles and transitive local imports                                   |
| Gradle/JUnit | `@lucasacoutinho/tiacore/gradle`     | Java/Kotlin test classes and local imports; JUnit result validation     |
| pytest       | `sdks/python`                        | Test files and transitive local imports                                 |
| Go           | `sdks/go`                            | Test and compile-only packages from the local package graph             |

The package needs Node.js `^22.12.0 || >=24.0.0`. Its peers are optional:
`vitest` >=4.1 <6, `vite` >=6 <9, and `@playwright/test` >=1.46 <2. See the
[compatibility contract](docs/architecture/capability-contract.md) for adapter
claims and certification levels.

The package is ESM only. Use `import`, or call `require()` on Node.js 22.12 or
newer. tiacore is written on Effect, and the package bundles it. You install no
Effect package, you write no Effect code, and no public type mentions Effect.

## Upgrade from 1.x

Three things change for most projects:

1. Run tiacore on Node.js 22.12 or newer. Node.js 20 is no longer supported.
2. Put `--` before a `tiacore verify` test command that has options of its own,
   as in `tiacore verify -- node run.mjs --flag`.
3. Expect one full run. 2.0 does not read a 1.x `.tia/` cache, and 1.x does not
   read a 2.0 cache.

The [1.x to 2.0 migration guide](docs/migration/1.x-to-2.0.md) lists the changes
to the CLI, the cache, and the runners.

## How it works

1. A full run records tests, runtime dependency edges, outcomes, coverage, and a
   project baseline.
2. A later run compares Git state or filesystem content with that baseline.
3. The adapter selects affected tests and previously failing tests.
4. A successful run commits the new graph atomically. Incomplete evidence does
   not replace the last valid graph.

The local cache uses a bounded atomic manifest and content-addressed record
buckets, so a small update does not rewrite one growing graph file.

The default cache is `.tia/`. Every Git worktree gets its own cache unless an
explicit shared path is configured. CI can restore an ancestral graph through
filesystem downloads, GitHub Actions, GitLab CI, an HTTP manifest, or a custom
artifact provider. Shared artifacts require a trusted Ed25519 producer
attestation by default.

## Known limits

- `tiacore verify` needs a runner that writes a phase snapshot. The Vitest,
  Node, Bun, Playwright, and TypeScript adapter runners do. k6, Gradle, Maestro,
  and the Python and Go SDKs plan impact graphs but run no tests, so a
  verification that reaches only them fails with `snapshot-invalid`.
- With `@effect/vitest`, a detached fiber that finishes during a later test gets
  that test's coverage. `tiacore verify` then reports different evidence when
  the first test is replayed. See
  [Testing with `@effect/vitest`](docs/guides/getting-started.md#testing-with-effectvitest).
- Interrupting a run of external suites (k6, Gradle, Maestro) from code stops
  the suite process but can leave its children running. Ctrl-C in a terminal
  reaches them.

## Documentation

- [Getting started and runner setup](docs/guides/getting-started.md)
- [Configuration and safety behavior](docs/guides/configuration.md)
- [CI, parallelism, shards, and worktrees](docs/guides/ci-and-parallelism.md)
- [Differential verification](docs/guides/verification.md)
- [TypeScript adapter contract](docs/guides/custom-adapters.md)
- [Monorepo benchmark baseline](docs/benchmarks/monorepo-baseline.md)
- [Migrating from 1.x to 2.0](docs/migration/1.x-to-2.0.md)
- [Observability: devtools, doctor, crash reports](docs/observability.md)
- [Public API](docs/public-api.md)
- [Target architecture](docs/architecture/target.md)
- [JavaScript SDK boundary](docs/architecture/javascript-sdk.md)
- [Protocol version 1](spec/protocol-v1.md)
- [Artifact attestation version 1](spec/artifact-attestation-v1.md)
- [Adapter capability contract](docs/architecture/capability-contract.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Development

```sh
npm ci
(cd .legacy && npm ci && npm run build)
npm run gate
```

`.legacy/` holds the 1.x source. Differential tests compare against its build,
so build it before the first test run.

`npm run gate` runs Oxfmt, Oxlint, the type check, the tests, and the
architecture check. `npm run check` is the same without the architecture check.
Other checks are `npm run check:package`, `check:python`, `check:go`,
`check:proofs`, and `check:vectors`. `npm run release:check` runs all of them,
then `npm audit` and `npm pack --dry-run`.

`npm run check:architecture` runs
[Archer](https://github.com/lucasacoutinho/archer) over `src/` with the rules in
`archer.config.ts`: no import cycles, resolvable imports, strict equality, the
layer table, no imports of `src/entries/`, and files under 800 lines. It needs
Node.js 22.18 or newer, so the Node.js 22.12 CI job skips it.

Source code is grouped by layer under `src/`, as
[effect-conventions.md](docs/architecture/effect-conventions.md) describes.
`src/entries/` holds one shim for each package export and the CLI launcher.

## License

tiacore is licensed under the [Apache License, Version 2.0](LICENSE). See
[NOTICE](NOTICE) for attribution.
