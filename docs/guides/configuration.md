# Configuration and safety

tiacore defaults are conservative. A setting may narrow known irrelevant files,
but uncertainty still expands to a full run unless you explicitly opt out. A
lockfile, package manifest, tsconfig, jsconfig, or Vite or Vitest config in a
parent of the project root is structural. `ignoreChanges` and
`onUnknownChange: 'ignore'` do not skip it.

## Vitest options

```ts
tia({
  cacheDir: '.tia',
  shardGroup: process.env.CI_PIPELINE_ID,
  include: ['packages/**/*.{js,jsx,ts,tsx}'],
  exclude: ['packages/generated/**'],
  ignoreChanges: ['docs/**', '**/*.md'],
  fresh: false,
  onUnknownChange: 'full',
  coverage: true,
  artifacts: {
    provider: 'filesystem',
    paths: ['.tia-artifacts'],
  },
  artifactTrust: {
    publicKeys: {
      'release-2026': process.env.TIA_ARTIFACT_PUBLIC_KEY!,
    },
    allowedProducers: ['release-ci'],
    allowedBaselineSources: ['git'],
    requirePromoted: true,
    maxAgeSeconds: 7 * 24 * 60 * 60,
  },
  frameworks: {
    database: true,
    views: true,
  },
  log: true,
})
```

| Option               | Behavior                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `enabled`            | Overrides automatic run and CI detection.                                                     |
| `cacheDir`           | Sets the graph location relative to the project root.                                         |
| `include`, `exclude` | Control which project modules receive instrumentation.                                        |
| `ignoreChanges`      | Ignores narrow, known-safe patterns. Test and structural files cannot be ignored.             |
| `fresh`              | Discards the reusable plan and records a full baseline.                                       |
| `onUnknownChange`    | Defaults to `full`. The `ignore` value is a global unsafe opt-out.                            |
| `shardGroup`         | Identifies fragments belonging to one complete sharded run.                                   |
| `artifacts`          | Restores baseline candidates from one or more providers.                                      |
| `artifactTrust`      | Authenticates candidates and restricts keys, producers, age, promotion, and baseline sources. |
| `frameworks`         | Adds explicit view, database, subprocess, or custom edges.                                    |
| `replayAdapters`     | Receives cached lifecycle events without mutating Vitest state.                               |
| `replayReporters`    | Sends detached cached-test events to named reporter instances.                                |
| `log`                | Prints baseline provenance, selection reasons, and a bounded recap.                           |

Node and Bun share `cacheDir`, `concurrency`, `files`, `fresh`, `ignoreChanges`,
`log`, `onUnknownChange`, `replayAdapters`, and `root`. Their cache paths are
namespaced by runner.

Artifact candidates are signed by default. If no trusted public key verifies a
candidate, TIA ignores it and records a full baseline. `allowUnsigned: true` is
an explicit migration escape hatch for a controlled local source; do not use it
for downloaded CI artifacts.

## Coverage

`coverage: true` reconstructs complete Istanbul `text`, `html`, and `json`
reports from fresh and cached per-test shards. The Vitest plugin keeps each
file's static coverage maps from its own instrumentation, so disable Vitest's
`experimental.fsModuleCache` while TIA records; otherwise TIA leaves the graph
unchanged and warns. An object can configure source inclusion, exclusions,
cleaning, failed-run reporting, report paths, reporter tuples, watermarks, and
Vitest-compatible thresholds:

```ts
tia({
  coverage: {
    include: ['packages/*/src/**/*.{js,jsx,ts,tsx}'],
    exclude: ['**/*.generated.ts'],
    clean: true,
    reportOnFailure: false,
    reportsDirectory: 'coverage',
    reporters: [
      ['text', { skipFull: true }],
      ['json', { file: 'coverage-map.json' }],
    ],
    thresholds: {
      lines: 90,
      branches: -10,
      'packages/core/**': { 100: true },
    },
    watermarks: {
      lines: [60, 90],
    },
  },
})
```

Positive thresholds are minimum percentages. Negative thresholds are maximum
uncovered counts. Global, per-file, `100`, and glob sets are supported.
Thresholds wait for a complete CI shard set. `thresholds.autoUpdate` is enforced
but does not rewrite the Vitest config.

## React and lazy imports

React Testing Library works through Vitest's normal jsdom or Browser Mode
environment. tiacore records modules and assets executed when a component
renders. `React.lazy()` and other dynamic imports become edges when a test loads
them.

A lazy component no test has loaded has no runtime edge. Changing it follows the
unknown-file policy, which defaults to a full run. This is intentional: the
graph cannot prove an owner for code it has never observed.

## Database, view, and subprocess edges

Files selected through runtime strings or another process do not appear in a
JavaScript import graph. Add explicit framework evidence when ownership is
stable:

```ts
tia({
  frameworks: {
    views: {
      roots: ['views', 'src/emails'],
      extensions: ['ejs', 'hbs'],
    },
    database: {
      migrations: ['migrations/**/*.sql', 'prisma/migrations/**/*.sql'],
      schemas: ['prisma/schema.prisma'],
    },
    subprocess: {
      mappings: [
        {
          tests: ['test/worker.test.ts'],
          files: ['src/worker/**'],
        },
      ],
    },
  },
})
```

The database adapter maps detected table use to matching migrations and schema
files. The view adapter resolves common render calls to existing templates.
Subprocess mappings are declarations, because a parent process cannot prove what
a child executed. Custom adapters can implement `TiaFrameworkEdgeAdapter`.

## Cached reporter events

Built-in Vitest reporters describe only work executed in the current process. An
external reporter can explicitly receive detached cached outcomes:

```ts
const externalReporter = new ExternalReporter()

export default defineConfig({
  plugins: [tia({ replayReporters: externalReporter })],
  test: {
    reporters: ['default', externalReporter],
  },
})
```

The reporter receives `onTestCaseReady` and `onTestCaseResult` with a
TestCase-compatible facade. `meta().__tiacore_cached__` and
`meta().__tiacore_replay__` are `true`. Callback errors become warnings and do
not corrupt the run.

## Selection explanations

Runtime plans report the baseline source and the reason for each selected test
or file. Console output is capped at 20 decisions. The same structured
`baseline` and `decisions` data is exposed in `RunPlan` and replay lifecycle
events. `formatRunPlanDetails()` from `@lucasacoutinho/tiacore/core` formats it
for custom logs.

## Safety rules

- A missing, corrupt, incomplete, unreachable, or incompatible graph runs the
  full suite.
- Lockfile, runner config, environment, or structural fingerprint changes run
  the full suite.
- Unknown changed files run the full suite unless a narrow `ignoreChanges` rule
  applies.
- Cached failures always rerun.
- Changes made during execution prevent graph promotion.
- A failed or incomplete run does not replace the last valid graph.
- Concurrent cases share conservative whole-file evidence because their coverage
  counters overlap.

See the [public API](../public-api.md) for exported types and runner-specific
contracts.
