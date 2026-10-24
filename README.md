# tiacore

Run the tests a change can affect. Reuse verified results for the rest.

tiacore records runtime dependencies and test outcomes during a full run. On the
next run, it compares the current project with that baseline, executes the
affected tests, and reuses unaffected results. Uncertain input causes a safe
full-suite run.

It supports Vitest, Playwright, `node:test`, `bun:test`, Maestro, k6,
Gradle/JUnit, pytest, and Go's native test runner. Git improves baseline
comparison, but it is optional.

tiacore 1.x is stable and licensed under Apache-2.0.

## Quick start

Install tiacore from npm:

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

The documented package entry points and versioned contracts follow Semantic
Versioning throughout 1.x. Internal cache storage may rebuild safely between
minor releases, but it is never treated as portable application data.

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

Vitest 4.1 and Node.js 20 or newer are required for the main package. The
standalone Node adapter requires Node.js 22.10 or newer. See the
[compatibility contract](docs/architecture/capability-contract.md) for adapter
claims and certification levels.

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

## Documentation

- [Getting started and runner setup](docs/guides/getting-started.md)
- [Configuration and safety behavior](docs/guides/configuration.md)
- [CI, parallelism, shards, and worktrees](docs/guides/ci-and-parallelism.md)
- [Differential verification](docs/guides/verification.md)
- [TypeScript adapter contract](docs/guides/custom-adapters.md)
- [Scherie benchmark baseline](docs/benchmarks/scherie.md)
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
npm run check
npm run check:package
npm run check:python
npm run check:go
```

`npm run check` enforces Oxfmt and Oxlint before type-checking and testing.

The optional cross-food check runs this suite with both `tia()` and Archer's
Vitest `archer()` plugin:

```sh
npm run build
npm run check:architecture
```

It prefers an installed `@lucasacoutinho/archer` package and otherwise uses a
built `../archer` checkout. Set `ARCHER_VITEST_ENTRY` for a checkout in another
location. This command is separate from `npm run check` so each repository can
still validate in a standalone checkout.

Implementation code is grouped by responsibility. `src/index.ts` is the only
file at the source root; package subpath shims and the CLI launcher live in
`src/entries/`.

## License

tiacore is licensed under the [Apache License, Version 2.0](LICENSE). See
[NOTICE](NOTICE) for attribution.
