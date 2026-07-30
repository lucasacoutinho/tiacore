# tiacore

Runner-neutral test impact analysis with adapters for Vitest, Playwright,
`node:test`, `bun:test`, Maestro, and k6.

`@usescherie/tiacore` records which project files actually execute while each
test case runs.
On the next run, it compares the project with that baseline and runs only
affected test IDs. Git repositories use a commit plus dirty-file hashes;
projects without Git or without an initial commit use a full relevant-file
content snapshot. This catches runtime and dynamic-import dependencies that
Vitest's static `--changed` and `related` graph cannot always see.

The design is adapted from Pest's TIA engine:

- Runtime test-case → test-file → source-file edges
- Vite module-graph edges for imported CSS, JSON, SVG, and other assets
- Git commit baselines with a filesystem-snapshot fallback
- Cached test outcomes and automatic failure reruns
- Cached per-test coverage shards and complete replay-time Istanbul reports
- Structural fingerprints for lockfiles, TypeScript, Vite, and Vitest config
- Conservative full-suite fallback when a changed source is unknown
- Transactional, portable state in `.tia/graph.json`

## Install

```sh
npm install --save-dev @usescherie/tiacore
```

The Vitest adapter requires Vitest 4.1 and Node.js 20 or newer. The `node:test`
adapter requires Node.js 22.10 or newer. The Bun adapter is verified on Bun
1.3. The Playwright adapter requires Playwright 1.46 or newer.

Until a private package is published, install this checkout through a local
file link or an exact VCS revision:

```sh
npm install --save-dev ../tiacore
npm install --save-dev \
  git+ssh://git@github.com/usescherie/tiacore.git#<exact-commit>
```

VCS installs build during `prepare`; generated `dist/` output is not committed.
Bun VCS consumers must pin a reviewed commit and list
`@usescherie/tiacore` in the root `trustedDependencies`. Bun does not install a
Git dependency's development toolchain, so tiacore's prepare hook provisions
the versions pinned by `package-lock.json` before compiling, then removes that
temporary toolchain so consumer peer dependencies remain authoritative. This
VCS-only bootstrap requires `npm`; private registry tarballs already contain
`dist/` and need neither the trust exception nor a source build.
Packed, linked, workspace, and VCS installations are supported. Every public
entry point provides both ESM and CommonJS exports, including Vitest configs
loaded from packages without `"type": "module"`. The public plugin shape is
version-neutral, so supported Vite versions do not leak incompatible nominal
types into consumer configs. The plugin creates a small setup proxy inside its
project-local cache so Vitest never needs to load an external package path as a
setup file.

## Compatibility certification

The checked-in compatibility workflow installs the packed tarball into real
fixture projects. Each Vitest fixture records once, runs again from cache, and
then verifies that its test body executed exactly once.

| Surface | Certified matrix |
| --- | --- |
| Vitest adapter | Vitest 4.1.0 + Vite 6.4.3 + Node 20.19; Vitest 4.1.10 + Vite 7.3.6 + Node 22.15; Vitest 4.1.10 + Vite 8.1.5 + Node 24 |
| `node:test` adapter | Node 22.10 aggregate discovery, Node 22.15 precise discovery, and Node 24 |
| `bun:test` adapter | Bun 1.3.0 and 1.3.14 |
| Package installation | npm, pnpm 11, Yarn 4 Plug'n'Play, Bun, and VCS dependencies |
| Module loading | ESM and CommonJS package modes |
| Paths and storage | Linux and native Windows runners, plus deterministic drive-letter, UNC, and mixed-separator cases |

The lower and upper Vite/Vitest combinations intentionally use the declared
peer range rather than only the repository lockfile. Node isolated coverage
runs execute in separate bounded child processes, so parallel files do not
share coverage counters. Yarn's generated PnP state and Vite's temporary
config-loader bundles are treated as tool state rather than project changes.

## Configure

### Vitest

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { tia } from '@usescherie/tiacore'

export default defineConfig({
  plugins: [tia()],
  test: {
    include: ['src/**/*.test.ts'],
  },
})
```

Keep the graph out of source control:

```gitignore
.tia/
```

Then run Vitest normally:

```sh
npx vitest run
```

The first invocation runs the full suite and records a baseline. Later
invocations collect affected files and execute only affected test IDs plus
previously failed cases. Cached siblings in an affected file are skipped before
their hooks and test bodies run. If nothing relevant changed, Vitest exits
successfully without executing tests.

### Playwright

Wrap the Playwright test fixture once:

```ts
// e2e/fixture.ts
import { expect, test as base } from '@playwright/test'
import { tia } from '@usescherie/tiacore/playwright'

export const test = tia(base)
export { expect }
```

Use that fixture in browser specs and append the tiacore reporter without
removing the project’s normal reporters:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'
import { tia } from '@usescherie/tiacore/playwright'

export default defineConfig({
  reporter: [['line'], ['html', { open: 'never' }], tia()],
  testDir: './e2e',
})
```

Run Playwright through a small runner:

```ts
// e2e/run-tia.ts
import { tia } from '@usescherie/tiacore/playwright'

const result = await tia({
  config: 'playwright.config.ts',
  name: 'qa',
  root: process.cwd(),
}).run(process.argv.slice(2))

process.exitCode = result.success ? 0 : 1
```

The first run executes the configured suite. On Chromium, the wrapped fixture
traces actually executed V8 ranges through JavaScript source maps and records
CSS source-map edges for every browser test. This includes route chunks and
lazy `import()` bundles without treating every module present in a large bundle
as executed. Other browser engines use the conservative source-map file list.
tiacore also follows relative imports from each spec through its fixtures and
support modules.
Later runs execute whole affected spec files and preserve Playwright’s workers,
retries, projects, and project dependencies. A no-change replay does not start
Playwright or its configured web servers.

Source maps are runtime evidence, not a required build format. If a script has
no usable source map, tiacore records a direct project URL when possible. A
changed project file with no recorded edge remains unknown and expands to the
full configured Playwright suite by default. This is deliberately stricter
than Playwright’s import-only `--only-changed` heuristic for end-to-end tests,
where the application normally executes in a separate browser and server.

Each Playwright config gets a separate cache such as
`.tia/playwright-feature/graph.json`. `TIA_FRESH=1` rebuilds it with a full run.
Use `name` when multiple lanes share one config but select different tests, so
each lane keeps an independent graph.
The runner accepts the same filesystem, GitHub Actions, and custom artifact
providers as the runner-neutral core, so a CI worker can restore an ancestral
graph before selecting files.

### Node test runner

Create a small runner script:

```js
// run-tia.mjs
import { tia } from '@usescherie/tiacore/node'

const result = await tia({
  concurrency: 4,
  files: ['test/**/*.test.mjs'],
}).run()

process.exitCode = result.success ? 0 : 1
```

Then use `node run-tia.mjs`. The Node adapter consumes the built-in test event
stream and per-run Node coverage; existing tests continue importing
`node:test`. On Node 22.15 and newer, initial discovery redirects `node:test`
only while modules register their cases, then runs every body exactly once in
its isolated coverage pass. Replay executes only selected cases. State is
stored in `.tia/node/graph.json`.

Node 22.10–22.14 do not expose the synchronous module hook needed for
non-executing discovery. Those releases use a single full-suite coverage pass:
bodies still run once, but every case receives the aggregate file dependency
set. Node 22.15+ provides per-case precision. Dynamically created subtests that
exist only inside another test body are conservatively attributed to that
parent execution.

### Bun test runner

```ts
// run-tia.ts
import { tia } from '@usescherie/tiacore/bun'

const result = await tia({
  concurrency: 4,
  files: ['test/**/*.test.ts'],
}).run()

process.exitCode = result.success ? 0 : 1
```

Run it with `bun run-tia.ts`. Bun discovery uses an impossible name filter, so
test bodies execute only during their isolated LCOV pass. Replay uses Bun's
native name filter and stores state in `.tia/bun/graph.json`.

All adapters expose the factory as `tia()`. `@usescherie/tiacore/core` also exports the
runner-neutral `TiaCore` and observation contract for custom runner adapters.
Node and Bun test names should be unique within a file; duplicate matching
names are conservatively observed together.

Both standalone adapters observe separate test files concurrently, up to
`min(4, available CPU parallelism)` by default. Set `concurrency` to a positive
integer to change that bound. Cases within one file stay sequential so enabling
TIA does not introduce new file-local races.

### Maestro and k6

The runner-neutral adapters discover real Maestro YAML flows and k6 profile
entrypoints; they do not require a separate suite manifest. Record a baseline,
then plan against a provider-supplied change list:

```sh
tiacore maestro record \
  --root . --flows apps/mobile/e2e --project mobile \
  --environment-fingerprint android-35 --output .tia/maestro.json

tiacore maestro plan \
  --root . --flows apps/mobile/e2e --project mobile \
  --environment-fingerprint android-35 \
  --graph .tia/maestro.json --changes .tia/changes.json

tiacore k6 record \
  --root . --profiles infra/load-testing/k6/profiles --project api \
  --environment-fingerprint k6-container --output .tia/k6.json

tiacore k6 plan \
  --root . --profiles infra/load-testing/k6/profiles --project api \
  --environment-fingerprint k6-container \
  --graph .tia/k6.json --changes .tia/changes.json
```

Maestro `runFlow` relationships and k6’s transitive local imports become
dependency edges. Native suites declare a device resource lock; k6 suites
declare a performance-host lock so an orchestrator can serialize resource-heavy
work while unrelated test lanes remain parallel. Plans never replay old native
or performance measurements as fresh results: `cached` means “unaffected and
not scheduled,” not “executed successfully.”

## Options

```ts
tia({
  cacheDir: '.tia',
  shardGroup: process.env.CI_PIPELINE_ID,
  include: ['packages/**/*.{js,jsx,ts,tsx}'],
  exclude: ['packages/generated/**'],
  ignoreChanges: ['docs/**', '**/*.md'],
  fresh: false,
  onUnknownChange: 'full',
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
  artifacts: [
    {
      provider: 'filesystem',
      paths: ['.tia-artifacts'],
    },
    {
      provider: 'github-actions',
    },
  ],
  frameworks: {
    database: true,
    views: true,
  },
  replayAdapters: [{
    onTestReplayed({ result }) {
      console.log(`replayed ${result.fullName}`)
    },
  }],
  log: true,
})
```

- `enabled`: overrides automatic run/CI detection.
- `cacheDir`: graph location, relative to the Vitest root by default.
- `shardGroup`: stable identity for one complete set of Vitest `--shard`
  processes. `TIA_SHARD_GROUP` is the environment equivalent. A deterministic
  local identity is used when neither is supplied.
- `include` / `exclude`: picomatch patterns controlling instrumentation.
- `ignoreChanges`: changed, unlinked files that may be ignored. Structural and
  test files are never ignored.
- `fresh`: discards the current graph and records the full suite.
- `onUnknownChange`: defaults to `full` for every file type. `ignore` is a
  global unsafe opt-out; prefer narrow `ignoreChanges` patterns.
- `log`: enables the TIA decision and replay recap.
- `coverage`: generates complete Istanbul reports by merging freshly executed
  and cached per-test shards. `true` uses `text`, `html`, and `json`; an object
  can select `include` / `exclude`, report cleaning, failed-test reporting,
  watermarks, the report directory, reporter names or `[name, options]` tuples,
  `skipFull`, and Vitest-compatible thresholds. An explicit coverage `include`
  adds matching unexecuted JavaScript, JSX, TypeScript, and TSX sources with
  zero hits; `exclude` filters both executed and zero-hit files. Positive
  thresholds are minimum percentages; negative thresholds are maximum
  uncovered counts. Global, `perFile`, `100`, and glob threshold sets are
  supported.
- `artifacts`: one source or an ordered array of sources for opt-in baseline
  discovery. `{ provider: 'filesystem', paths: ['.tia-artifacts'] }`
  recursively reads downloaded `graph.json` files and works with any CI or
  object-storage downloader. `{ provider: 'github-actions' }` is the optional
  direct API integration; it uses `GITHUB_REPOSITORY` and `GITHUB_TOKEN` and
  accepts `repository`, `artifactName`, `branch`, `runId`, `tokenEnv`, `apiUrl`,
  and `maxArtifacts`. Custom providers implement
  `{ name, async load({ fingerprint, root, runner }) }`. Shared tiacore code
  validates every returned graph before storing it.
- `frameworks`: opt-in edges for files selected through runtime strings rather
  than imports. `views: true` recognizes common server-template formats and
  roots. `database: true` maps SQL/ORM table usage to matching migration files
  and schema files. Both accept configuration objects; `adapters` accepts a
  custom `{ name, fingerprint?, resolve(context) }` integration.
- `replayAdapters`: one adapter or an array of adapters with optional
  `onRunStart`, `onTestReplayed`, and `onRunComplete` callbacks. Adapter errors
  are reported as warnings and never fabricate Vitest test nodes.
- `replayReporters`: explicit third-party Vitest reporter instances that should
  receive detached `onTestCaseReady` and `onTestCaseResult` events for cached
  outcomes. The same instance must also be present in `test.reporters`.

The Node and Bun factories share `cacheDir`, `concurrency`, `files`, `fresh`,
`ignoreChanges`, `log`, `onUnknownChange`, `replayAdapters`, and `root`. Their
cache directory is namespaced by runner.

Environment controls are also available:

```sh
TIA=0 npx vitest run       # bypass TIA
TIA_FRESH=1 npx vitest run # rebuild the graph
```

Watch mode uses Vitest's native module graph and is left untouched. Running
Vitest with explicit file, project, test-name, related-file, changed-file, tag,
or CLI exclusion filters also uses Vitest's native selection and does not
replace the reusable full-suite graph. Running Vitest with `--coverage`
automatically enables tiacore coverage reconstruction:
the affected cases execute, cached shards are merged, and the configured
Istanbul reporters write into Vitest's report directory with their tuple
options intact. `include`, `exclude`, `clean`, `reportOnFailure`, `skipFull`,
and reporter watermarks retain their Vitest behavior. `cleanOnRerun` remains
owned by Vitest because tiacore deliberately bypasses watch mode. The configured
global, per-file, `100`, positive/negative, and glob thresholds are checked
against the reconstructed map and set a failing exit status using
Vitest-compatible diagnostics. This replaces the native provider for that run
so a partial provider report cannot masquerade as full-suite coverage.

Thresholds are deferred for an individual CI shard because its map is
deliberately incomplete; they run after a complete partition set is restored
and merged. `thresholds.autoUpdate` still enforces its configured values, but
tiacore warns instead of rewriting the Vitest configuration file.

Browser Mode is supported with the same recording, exact-case replay, and
cached coverage behavior as Node-based Vitest projects. Configure a normal
Vitest browser provider and its headless browser as usual; `tia()` does not
replace or configure the browser provider.

### Third-party reporter replay

By default, cached outcomes appear only in tiacore’s recap and replay-adapter
callbacks. A third-party reporter that needs per-test events can opt in:

```ts
const externalReporter = new ExternalReporter()

export default defineConfig({
  plugins: [
    tia({
      replayReporters: externalReporter,
    }),
  ],
  test: {
    reporters: ['default', externalReporter],
  },
})
```

For each cached outcome, tiacore calls `onTestCaseReady` followed by
`onTestCaseResult` with a detached TestCase-compatible facade. Its public
`id`, `name`, `fullName`, `module`, `project`, `result()`, `diagnostic()`, and
`meta()` APIs are populated. `meta().__tiacore_cached__` and
`meta().__tiacore_replay__` are `true`.

Only explicitly supplied instances receive these events. The facade is never
registered in Vitest state, so built-in summaries, exit status, module trees,
coverage, and other reporters continue to describe work executed in the
current process. Reporter callback errors become warnings and do not fail or
corrupt the run.

## React Testing Library

React Testing Library tests running in Vitest's jsdom environment are supported.
TIA instruments the transformed JavaScript, JSX, TypeScript, and TSX modules
executed when components render, then augments those runtime edges with imported
CSS, JSON, SVG, and other project assets from Vite's module graph. This path is
covered by an integration test using React, React DOM, `@vitejs/plugin-react`,
Testing Library, and jsdom.

`React.lazy()` and other dynamic component imports are recorded when the test
actually renders or preloads them. A change to that lazy chunk selects the test
that caused the import, while its cached siblings remain replayed. A lazy
component that no test ever imports has no runtime edge; changing it therefore
uses the normal unknown-file policy, which defaults to a safe full-suite run.

The same behavior is covered in a real headless Chromium Browser Mode run,
including a linked package install, CSS dependency selection, exact-case replay,
and a mixed Node/browser workspace. Assets referenced only by runtime strings
or external processes cannot appear in Vite's import graph; an unknown asset
change therefore expands to a full run unless explicitly ignored.

## Subprocess boundary

TIA attributes modules executed in Vitest workers and browser sessions. Code
run only by a separately spawned Node, Bun, shell, or service process does not
share that worker's Istanbul map, so tiacore does not claim a per-test dependency
or executed coverage for it. An explicit coverage `include` still lists the
source at zero hits.

This boundary fails safely: changing an unlinked subprocess source is an
unknown change and therefore runs the full suite by default. If an application
has a stable subprocess-to-test mapping, add those files with a custom
framework edge adapter; do not use `ignoreChanges` for executable subprocess
code. A checked-in fixture launches a real Node child, proves it is not
misattributed, verifies zero-hit reporting, and verifies its edit expands to a
full run.

## Framework database and view edges

JavaScript frameworks often select templates and database migrations through
runtime names, so those files do not appear in Vite's import graph. These edges
are opt-in:

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
  },
})
```

The view adapter examines source modules actually executed by each test,
resolves literal and logical render names, and links only existing project
templates. The database adapter recognizes SQL statements, common query-builder
forms, Drizzle table declarations, and Prisma model operations. A migration is
linked only when its parsed tables overlap a table used by that test; schema
files are linked to every detected database test. Unparseable or dynamically
constructed names remain unknown and therefore trigger the normal full-run
fallback when changed.

Custom integrations can implement `TiaFrameworkEdgeAdapter`. Returned paths are
contained to the project root, adapter identity is included in the structural
fingerprint, and an adapter exception prevents graph persistence rather than
silently recording incomplete edges. A checked-in fixture executes real
in-memory `node:sqlite` queries and EJS rendering, then verifies migration and
template edits select the corresponding tests.

## Parallelism and worktrees

Vitest file parallelism remains enabled. TIA setup state is worker-local and
the reporter combines completed module observations in the main process. The
checked-in stress suite runs 16 real files with both thread and fork pools,
compares serial and parallel dependency/coverage graphs over repeated
schedules, proves worker overlap, and verifies exact affected-file selection.

`test.concurrent` is handled at a deliberately wider boundary. Istanbul
counters are shared by overlapping cases in one worker, so a module containing
any concurrent case stores one exact module-level dependency and coverage
shard. An affected dependency or cached failure reruns that whole test file.
Unchanged concurrent files are still fully replayed from cache.

Graph updates use a short cross-process transaction: a writer locks only the
commit, rereads the current generation, merges disjoint changes planned from
the same graph, and atomically renames the result. Conflicting overlapping
updates fail closed and leave the winning valid graph untouched. Dead local
writer locks are recovered through PID and host metadata.

Every Git worktree gets its own `.tia` directory by default and can run at the
same time. Graphs are portable between worktrees when the recorded commit is
an ancestor of the target; a non-ancestor graph forces a full run. An absolute
shared `cacheDir` is safe for identical worktree states, but diverged worktrees
cannot share one baseline: one commit wins and the incompatible writer warns
without overwriting it. Prefer the default per-worktree cache for active
branches.

## CI cache

The graph is portable across checkouts as long as the OS, architecture, Node
major version, lockfile, and test configuration match. Cache it between commit
runs:

```yaml
- uses: actions/cache@v4
  with:
    path: .tia
    key: tiacore-${{ runner.os }}-${{ github.sha }}
    restore-keys: |
      tiacore-${{ runner.os }}-

- run: npm test
```

Use a unique key for each commit and a restore prefix. GitHub Actions caches
are immutable, so a single lockfile-only key would keep restoring the first
graph forever.

Alternatively, opt into the built-in GitHub Actions artifact source with
`tia({ artifacts: { provider: 'github-actions' } })`. The artifact subsystem
itself is platform-neutral: an ordered provider contract handles other CI and
object-storage systems without changing the planner. The GitHub source searches
recent, unexpired artifacts named `tiacore` and downloads only enough candidates
to find a graph with the current structural fingerprint. ZIP entries are read
in memory; tiacore never extracts arbitrary archive paths. Unavailable,
oversized, corrupt, or incompatible artifacts fall back to the next provider
and ultimately a full run.

```yaml
permissions:
  actions: read
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      GITHUB_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: npm ci
      - run: npm test
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: tiacore
          path: .tia
          if-no-files-found: ignore
```

The token needs Actions read access for private repositories. A full Git
history lets tiacore use a compact, ancestry-verified commit baseline. Without a
usable `HEAD`, tiacore stores a larger content-hash snapshot instead.

### CI shards and partial coverage

Vitest `--shard=<index>/<total>` runs automatically write isolated partial
graphs below `.tia/fragments/<group>/<index>-of-<total>/graph.json`, so local
shards can execute simultaneously with one configured `cacheDir`. Each
fragment contains complete per-test coverage for its own shard but is
deliberately unusable by itself. The last compatible shard promotes the set to
`.tia/graph.json` and runs coverage thresholds. A set is merged only when
every partition has the same group, baseline, structural fingerprint, count,
and non-conflicting overlapping records. Missing, mixed-run, corrupt, or
conflicting fragments are ignored.

For GitHub Actions matrices, give every immutable v4 artifact a unique name and
discover the set with a pattern:

```ts
tia({
  artifacts: {
    provider: 'github-actions',
    artifactName: 'tiacore-shard-*',
  },
})
```

```yaml
strategy:
  matrix:
    shard: [1, 2]
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  - run: npm ci
  - run: npx vitest run --shard=${{ matrix.shard }}/2
    env:
      TIA_FRESH: '1'
      TIA_SHARD_GROUP: ${{ github.run_id }}-${{ github.run_attempt }}
  - uses: actions/upload-artifact@v4
    with:
      name: tiacore-shard-${{ matrix.shard }}
      include-hidden-files: true
      path: .tia/fragments
```

GitHub workflow-run IDs become merge-group IDs automatically. Custom providers
should return the same `group` value on candidates belonging to one complete
partition set. Once merged, normal replay and full coverage reconstruction use
the combined graph.

The artifact transport does not need to be GitHub. On GitLab, Buildkite,
CircleCI, Jenkins, or an object-storage aggregation job, download every shard
directory under one location and use:

```ts
tia({
  artifacts: {
    provider: 'filesystem',
    paths: ['.tia-artifacts'],
  },
})
```

Set `TIA_SHARD_GROUP` to that platform's pipeline/run identifier while
producing shards. The aggregation run validates and merges the downloaded
fragments; the downloader itself remains outside tiacore. The repository CI
workflow uses this provider-neutral ingestion path after its GitHub-specific
artifact download step.

## Safety model

TIA is an optimization, so uncertainty must expand the run:

- A missing, corrupt, incomplete, or unreachable baseline runs the full suite.
- A lockfile or test configuration fingerprint change runs the full suite.
- Any changed file with no recorded edge runs the full suite unless it matches
  an explicit `ignoreChanges` pattern.
- Failed cached tests are always rerun.
- Changes made during a test run prevent the graph update.

The cache stores passing, failing, and skipped outcomes plus portable,
project-relative Istanbul coverage shards. Cached tests are not injected into
Vitest's native reporter tree, so its built-in summary shows only tests executed
in the current process. Replay adapters and explicitly targeted replay
reporters provide integration points for external consumers. This corresponds
to Pest TIA's filtered execution mode; the TIA recap reports how many
unaffected outcomes were reused.

Runtime dependency metadata is stored per Vitest test ID. Collection-time
dependencies and imported non-JavaScript assets are shared conservatively
across cases in the same module. Modules containing concurrent cases use exact
whole-file metadata rather than overlapping per-case snapshots. Changed test
files, genuine module failures, concurrent modules, and legacy graphs without
complete per-test metadata deliberately run the whole affected file.

## Current scope

This first release targets Vitest projects using Node thread/fork pools or
Browser Mode, Playwright end-to-end projects with browser source maps, Node's
built-in test runner, and Bun's test runner. Git is used when available, but an
uncommitted or non-Git project can reuse a local filesystem baseline.

Inline Vitest 4 projects are supported when they inherit the root plugin with
`extends: true`; affected files are intersected with each project's include and
exclude patterns. Mixed Node/browser Vitest workspaces share one portable
Vitest graph, while other runners have namespaced graphs.

Native coverage-provider reporting is reconstructed through Istanbul.
Explicitly included zero-hit files, exclusions, cleaning, failed-test
reporting, watermarks, reporter tuple options, and threshold enforcement are
preserved. A real fixture compares native V8 and reconstructed per-file
coverage. The provider-specific `thresholds.autoUpdate` configuration rewrite
is intentionally not performed.

Persisted graph and coverage paths always use project-relative forward slashes.
Drive-letter, UNC, mixed-separator, cache-containment, and Istanbul path cases
have deterministic Win32 tests that also run on Linux. The
`Cross-platform paths` workflow runs the focused storage and path suite on both
`ubuntu-latest` and `windows-latest`.

## Project policy

- [Public API and compatibility policy](docs/public-api.md)
- [Adapter capability contract](docs/architecture/capability-contract.md)
- [Protocol-first portability decision](docs/architecture/decisions/0001-protocol-first.md)
- [JavaScript SDK boundary](docs/architecture/javascript-sdk.md)
- [Protocol version 1 specification](spec/protocol-v1.md)
- [Adapter conformance scenarios](conformance/adapter/v1/scenarios.json)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Non-publishing release process](docs/releasing.md)
- [Changelog](CHANGELOG.md)

## Source layout

The package keeps only its stable entry points at the source root:
`index.ts`, `core.ts`, `playwright.ts`, `node.ts`, and `bun.ts`.
Implementation details are grouped by responsibility:

```text
src/
├── artifacts/  provider-neutral restoration and built-in CI providers
├── playwright/ Playwright runner, reporter, fixture, and source-map edges
├── coverage/   runtime coverage deltas and report generation
├── frameworks/ database, view, and custom dependency adapters
├── graph/      baselines, fingerprints, planning, merging, and storage
├── runners/    runner-neutral core plus Node and Bun adapters
├── runtime/    shared replay lifecycle behavior
├── shared/     portable types, constants, and path utilities
└── vitest/     plugin, setup hooks, module graph, reporter, and augmentations
```

These folders are internal. Consumers should continue importing only
`@usescherie/tiacore`, `@usescherie/tiacore/core`,
`@usescherie/tiacore/protocol`, `@usescherie/tiacore/maestro`,
`@usescherie/tiacore/k6`, `@usescherie/tiacore/playwright`,
`@usescherie/tiacore/node`, or `@usescherie/tiacore/bun`. The build clears
`dist/` first so renamed internals cannot remain in packed releases as stale
files. Generated output is excluded from source control and rebuilt by
`prepare` for both VCS installs and tarballs.

The parallel performance harness is a Vitest benchmark in `benchmark/`, not a
standalone maintenance script. Run it with `npm run benchmark:parallel`.

## License

tiacore is proprietary software. All rights are reserved. See [LICENSE](LICENSE)
for the applicable terms.
