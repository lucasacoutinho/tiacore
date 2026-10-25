# Changelog

All notable changes to tiacore will be documented here. Published releases
follow Semantic Versioning.

## 2.0.0 - Unreleased

tiacore 2.0 is a rewrite on Effect 4 and TypeScript 7. It keeps every 1.x
package entry point, export name, CLI flag and exit code, and every versioned
wire contract (protocol, adapter API, artifact attestation and manifest,
verification snapshot, verification receipt). Effect is bundled. You install no
Effect package and write no Effect code, and no public type mentions Effect. The
[migration guide](docs/migration/1.x-to-2.0.md) says what to change.

### Breaking changes

- The protocol contract moved inside the package. The specs, JSON Schemas,
  conformance vectors and the adapter capability contract were at the package
  root in `spec/`, `schemas/`, `conformance/` and `capabilities/`. They are now
  under `docs/protocol/`: for example `docs/protocol/schemas/` and
  `docs/protocol/conformance/protocol/v1/`.
- Requires Node.js `^22.12.0 || >=24.0.0`. Node.js 20 and 22.0 to 22.11 are no
  longer supported.
- The package is ESM only. The CommonJS build and the `main` and `module` fields
  are gone. `require()` of every entry point works on Node.js 22.12 and newer
  through Node's `require(esm)`. The entry points are the same, and
  `./package.json` is now exported too.
- The local cache has a new layout (graph schema 6, store version 4). 2.0 does
  not read a 1.x cache and 1.x does not read a 2.0 cache, so the first run after
  the upgrade is a full run that records a new baseline. Sort order and path
  normalization changed, so graph digests change once.
- `tiacore verify` needs `--` before a test command that has options of its own,
  as in `tiacore verify -- node run.mjs --flag`. Without it, the parser rejects
  the unknown flag. 1.x forwarded it.
- `tiacore help <command>` is gone. Use `tiacore <command> --help`. Help and
  usage-error text changed. Both are outside the CLI contract.
- A coverage threshold glob that matches no file now fails with an error that
  names the threshold. 1.x let it pass.

### Added

- `TiaEvidence.collectChecked()` returns the collected files and whether every
  event was read. The Playwright fixture uses it: when an event is lost, the
  test's dependencies count as incomplete and the graph is not updated.
- `tiacore devtools` listens for spans and metrics from tiacore processes run
  with `TIACORE_DEVTOOLS` and prints a live summary: slowest spans, time by span
  name, failed spans and metrics. It uses Effect's devtools protocol, on
  `ws://localhost:34437` by default.
- `tiacore doctor` without `--graph` checks the install: Node.js, git, peers,
  and the cache and crash directories. `--perf` also times a cold prepare, a
  commit and a warm prepare on a throwaway git project and ranks the slowest
  phases. `--json` prints JSON. `doctor --graph` still validates a graph.
- Observability that stays off until you set a variable: `TIACORE_DEVTOOLS`,
  `TIACORE_OTLP_URL`, `TIACORE_TRACE_FILE`, `TIACORE_METRICS_FILE` and
  `TIACORE_CRASH_DIR`. Stage spans and three run metrics (`tia_runs_total`,
  `tia_run_duration_ms`, `tia_heap_used_bytes`) cover the runners. Exporters
  flush when the process ends, or half a second after the last library run. See
  `docs/observability.md`.
- Crash reports. A defect, which is a bug in tiacore and not an input error or a
  failed test, writes a report under `.tia/crashes` and prints its path, for
  library calls and CLI commands. The directory keeps the 20 newest reports.
- `tiacore verify --artifacts <dir>` is documented. It keeps the phase snapshots
  of each verification.
- The Python SDK reads `TIA_FRESH`.
- Shared test vectors. `conformance/protocol/v1/generated-plans.json` holds 400
  plans from the TypeScript planner, and the TypeScript, Python and Go planners
  reproduce them. `conformance/selection/v1/vectors.json` holds 500 selection
  problems answered by a Lean model of the selection kernel.
- `ws` is a runtime dependency. The devtools server needs it.
- Retention for the filesystem artifact sink. `TiaFilesystemArtifactSinkOptions`
  takes `retention: { keep?, maxAgeDays? }` or `false`, and
  `tiacore artifacts publish|promote` takes `--keep`, `--max-age-days` and
  `--no-prune`.

### Changed

- The filesystem artifact sink and `tiacore artifacts publish|promote` now prune
  their output directory. 1.x kept every archive, so a long-lived directory grew
  without bound. After each published manifest the sink keeps the 20 newest
  `tiacore-<digest>.zip` files, any archive the manifest lists, and the newest
  unexpired promoted archive of each runner and fingerprint, and deletes the
  rest. An archive written in the last 10 minutes is never deleted. Other files
  are never touched. To keep the old behavior, pass `retention: false` or
  `--no-prune`.
- The `tiacore` bin enables Node's compile cache, so commands after the first
  start faster. `NODE_DISABLE_COMPILE_CACHE=1` turns it off. Library imports do
  not change how the host process compiles modules.
- A CLI command and the engine work it starts share one runtime, so a process
  opens one Effect devtools connection and one set of OTLP exporters.
- A Vitest run that replays some tests of a file keeps the file's shared
  evidence (module load and hooks) and adds what it observed. A run that only
  replays an `@effect/vitest` unnamed layer block now passes `tiacore verify`.
- Rewrote the engine, runners, CLI and verification on Effect 4. `commander` is
  gone. The CLI uses Effect's CLI parser, so it has the global flags
  `--completions`, `--wizard`, `--log-level` and `-v`. `-v` prints
  `tiacore v<version>`. `--version` and `-V` print the bare version.
- `TIA_FRESH` accepts `1`, `true`, `yes` and `on` in any case in every runner
  and in the Go and Python SDKs. Before, only the Vitest plugin did. Playwright,
  the shared engine and Go accepted only `1`.
- `TIACORE_NODE_DEBUG` accepts `1`, `true`, `yes` and `on` in any case, like
  every other flag. Before, only `1` turned on the Node execution child's
  diagnostics.
- `@types/istanbul-lib-instrument` is a development dependency. No public
  declaration references it.
- Sorting uses UTF-16 code unit order everywhere, so results no longer depend on
  the locale. A trailing slash is dropped from paths, so `a` and `a/` name one
  path.
- `allowedSuites` now limits the dependency closure to the allowed suites and
  reports the disallowed dependents. Before, the closure escaped the allowed
  set.
- The store keeps the working-tree list as its own object, so a project with
  more than about 10,000 dirty files no longer throws. An unreferenced object is
  deleted 24 hours after its last use, and reuse counts as a use.
- Artifact restore skips a candidate whose baseline commit is not an ancestor of
  `HEAD`. Attestation checks run in the order the specification gives:
  signature, digest, identity, runner, validity window, then policy. Archive
  reads are bounded at 10,000 entries, 64 MiB inflated, 8 nested archives and a
  500:1 expansion ratio above 1 MiB. Every artifact request has a 60 second
  deadline. Attestations and manifests are checked against their JSON Schemas,
  and a manifest with one invalid entry yields no candidates.
- Artifact publication is deterministic. Equal graphs under one clock give the
  same archive bytes, digest and name. Signing keys can be PEM, PEM with literal
  `\n`, or base64 DER.
- Node: an aggregate pass with a module failure, crash or timeout reports
  `success: false`, saves no graph and commits nothing. The execution child
  group gets `SIGKILL` at 30 seconds. `test.skip` and `it.todo` through
  `require("node:test")` record as skipped. A `concurrency` of `NaN` is rejected
  when the configuration is decoded, for Node and for workspaces.
- Node and Bun: a `concurrency` of `Infinity` is rejected like `NaN`. 1.x
  started every test file at once.
- Playwright: a filter list over 24,000 characters falls back to a full run and
  says why. The warning for incomplete evidence keeps its text and adds
  `TIA detail:` lines. The count of cached tests excludes specs that rerun.
  Imports are found with `es-module-lexer`, not a regular expression. A source
  map under `node_modules` is never attributed. A run commits `complete: true`
  and `coverageComplete: false`, because selection is file-level.
- Gradle rejects result XML older than the run start.
- k6 ignores type-only imports. When a profile cannot be lexed, it runs the full
  suite before it runs anything. A successful run with an unlexable profile
  writes a `complete: false` graph.
- Maestro follows `runFlow` transitively, scans every YAML document, and
  excludes `config.yaml` and `config.yml` at the flows root only.
- Running children of an external-suite run stop when the run fails or is
  interrupted.
- A baseline treats directories, FIFOs and sockets as unavailable and refuses
  files of 2 GiB or more.
- Verification clears `TIA_FRESH` for the selective phase, inherited or passed
  in `environment`. The full phase sets it to `1`. The selection audit uses the
  planner's own kernel. A malformed snapshot or plan fails verification with an
  `invalid TIA verification snapshot` message. `certify execute --spec` decodes
  the spec and fails on a malformed one.
- With `@effect/vitest`, coverage of a layer's construction and finalizers
  belongs to every test of the file, so editing a module a layer uses selects
  them all.
- With `@effect/vitest`, a detached fiber (`Effect.forkDetach`) that finishes
  while a later test runs is no longer charged to that test. The modules it
  touches belong to the whole test file, so editing one selects every test of
  the file. A run that replays the forking test keeps that evidence, so the
  module stays known to the graph and `tiacore verify` agrees between its
  phases. Tiacore finds the forking test through the async context Effect 4
  keeps for each fiber, on Node.js. Work that is not an Effect fiber, such as a
  timer callback, is still charged to the test that is running.
- The Python and Go SDKs reproduce every protocol vector and share the
  TypeScript planner's reasons, check order and glob subset. They also fix
  `build` and `dist` paths, root-level packages and the `dependsOn` closure.
- The Python SDK (`tiacore-pytest`) takes the package version, 2.0.0. The Go SDK
  has no version of its own.
- A CLI crash writes a crash report, as a library call already did. A report
  directory keeps the 20 newest reports.
- Baseline capture and change detection start fewer git processes. One
  `git rev-parse` answers both HEAD and the repository top, so a cold prepare or
  commit in a git project starts three git processes where 1.x started five. A
  HEAD that has not moved since the stored baseline is no longer checked for
  ancestry. The answers are the same.
- Exporters flush when the process ends or half a second after the last library
  run. Before, a process with `TIACORE_DEVTOOLS` or an OTLP URL did not end on
  its own, and the trace and metrics files were written only on dispose.
- A bad `TIA_VERIFICATION_DIRECTORY` or `TIA_VERIFICATION_PHASE` fails a run
  when it starts (`prepare`, or the Vitest plugin at run start). Before, the run
  executed its tests and saved its graph, and the commit then rejected. A commit
  writes only to the target read at the start, whatever the process environment
  holds by then.

### Fixed

- Node runner on Node 22.12 to 22.14, where `node:test` cases cannot be
  discovered without running them: each test file now runs whole in its own
  child, and re-running affected cases runs their files whole too. Before, one
  child ran every file and a case depended on everything that run touched, so a
  selective and a full run recorded different evidence and `tiacore verify`
  failed.
- Evidence events are written under a temporary name and renamed, so a reader
  never sees a partial event.
- Waiting for the commit lock can be interrupted. Before, an interrupted commit
  waited until it took the lock or timed out, up to 10 seconds.
- The runtime planner missed tests in `__tests__` directories.
- The Vitest plugin kept the coverage templates of every file version it had
  transformed in the same process.
- A refused or oversized artifact response, or Playwright source-map response,
  kept its connection open.
- A file that was re-instrumented during a run lost counter increments.
- Results of test files that no longer exist were replayed and counted.
- A stale state lock was removed and recreated, which raced other waiters. It is
  now renamed away and its owner checked.
- A `__proto__` coverage key in a schema-3 graph replaced a prototype. Such a
  graph is rejected.

## 1.2.1 - 2026-10-25

### Added

- Supported Vitest 5 alongside Vitest 4.1. The `vitest` peer range is now
  `>=4.1.0 <6.0.0`.

### Changed

- With Vitest 5, the plugin turns off `fsModuleCache` and `sharedViteServer`
  unless the configuration sets them. A cached transform skips tiacore's
  coverage instrumentation, and a shared Vite server skips the plugin's
  per-project setup. An explicit `fsModuleCache: true` still fails safe to a
  full run, as before.
- Updated runtime dependencies within their ranges, including
  `es-module-lexer` 3.

## 1.2.0 - 2026-10-24

### Breaking changes

- Renamed the package from `@usescherie/tiacore` to `@lucasacoutinho/tiacore`.
  Update imports, configuration, and `trustedDependencies` entries to the new
  scope. No public consumers of the old name exist; it was only distributed
  through a private registry and VCS revisions. Earlier entries in this file use
  the new name.
- Renamed the Go module to `github.com/lucasacoutinho/tiacore` and the artifact
  schema `$id`s to `https://lucasacoutinho.github.io/tiacore/schemas/`.

### Changed

- Licensed tiacore and the pytest SDK under Apache-2.0 and added a `NOTICE`
  file.
- Moved the repository to `github.com/lucasacoutinho/tiacore`.
- Replaced private registry publication (`publish:private`) with public npm
  publishing through npm trusted publishing (OIDC) with provenance.

## 1.1.0 - 2026-10-11

### Added

- Added a standalone Go SDK and CLI that records filesystem baselines, maps
  native package dependencies to protocol-v1 package suites, selects affected
  packages, and fails safely to the full Go suite when evidence is missing or
  incompatible.

### Changed

- Qualified the Go adapter without overstating replay: `go test` retains
  ownership of workers and its native build/test cache, while tiacore stores
  only dependency and baseline evidence.
- Moved the JavaScript runtime graph to schema 4 and the runtime store to
  version 2. Each file's static Istanbul maps are now stored once in
  `TiaRuntimeGraph.coverageMaps`, and per-test and collection coverage keep only
  advanced counters. Stored state for a 96-test synthetic project drops from
  229.5 MB to 0.8 MB with identical edges, results, and reconstructed coverage.
  Existing caches are not read; the first run after upgrading records a full
  baseline.
- Graph digests now come from the segmented store's manifest generation, and
  artifact publication and verification snapshots write graphs piece by piece,
  so no step serializes a whole graph into one string. Artifact `graph.json`
  keeps the schema-3 layout and 20 MiB limit; restore converts it.

### Fixed

- Stopped the Vitest adapter from sending and retaining full Istanbul maps for
  every test. Workers now report only advanced counters and the file's
  instrumentation hash. The main process keeps one copy of each file's
  statement, function, and branch maps from its own instrumentation, rebuilds
  identical graph coverage at the end of the run, and removes tiacore metadata
  from Vitest tasks once recorded. Per-test task metadata no longer grows with
  source size, and main-process memory no longer grows with every test file.
- Because the main process now owns the static maps, a run that executes code
  tiacore did not instrument in that run leaves the graph unchanged with a
  warning. Vitest's `experimental.fsModuleCache` can cause this by serving
  cached transforms; disable it while TIA records.

## 1.0.2 - 2026-07-31

### Changed

- Added Archer architecture checks for tiacore's source layers, entry points,
  dependency cycles, module resolution, and source size.
- Extracted shared engine contracts so replay types no longer depend on the
  engine facade that imports them.

### Fixed

- Canonicalized native `node:test` file URLs and real paths before recording
  per-test dependencies. This preserves precise selection on Windows and on
  macOS temporary directories that resolve through `/private`.
- Kept CommonJS `node:test` discovery independent of release-specific
  module-hook condition shapes and built-in redirection behavior.
- Supplemented native `node:test` coverage with V8 child-process data when
  Node's coverage event omits executed modules.
- Kept browser-installed Playwright tests in their dedicated compatibility job
  and isolated the Yarn package-install fixture from the repository project.
- Allowed Python release builds to resolve their build backend on fresh runners
  instead of requiring a pre-populated local package cache.

## 1.0.1 - 2026-07-31

### Changed

- Upgraded the development compiler to TypeScript 7.0.2 and the default Vite
  integration fixtures to Vite 8.2.0 with `@vitejs/plugin-react` 6.0.5.

## 1.0.0 - 2026-07-31

### Added

- Added independent shadow verification of selective runs. Verification now
  derives required tests from the before/after dependency-graph union and
  reports selection misses, false-negative rate, and precision.
- Added signed, provider-neutral baseline artifacts with Ed25519 producer
  attestations, bounded claims, lineage, expiry, and promotion policy. Shared
  artifacts are rejected by default unless their producer is trusted.
- Added the stable TypeScript adapter API at `@lucasacoutinho/tiacore/adapter`.
  Third-party runners implement discovery and execution behind the single
  `tia()` factory while tiacore owns planning, replay, verification, artifacts,
  and persistence.
- Added explicit public version constants for the TypeScript adapter, artifact
  attestation and manifest, verification snapshot and receipt, runner-neutral
  protocol, and adapter conformance contracts.

### Changed

- Replaced the monolithic local runtime graph with an atomic bounded manifest
  and content-addressed record buckets. Small updates reuse unchanged objects;
  invalid or incomplete state fails closed and rebuilds safely.
- Qualified the supported JavaScript adapters across their failure paths and
  expanded Linux, Windows, macOS, Bun, native Node, and Chromium Browser Mode CI
  gates. Native runners retain their own parallelism and resource control.
- Added repository-wide Oxfmt and Oxlint checks to the default local and CI
  quality gate.
- Declared the documented package entry points and versioned wire formats as the
  stable 1.x compatibility surface. Internal storage layout remains rebuildable
  implementation detail.

### Fixed

- Prevented k6, Maestro, and Gradle failures from promoting partial state.
- Prevented failed Playwright specs from being replayed as passing cached work.
- Treated failed or missing Gradle JUnit results as incomplete execution even
  when the Gradle process exits successfully.
- Made the documented fresh release gate independent from record/replay tests
  that intentionally override inherited `TIA_FRESH` behavior.
- Shipped the Istanbul declaration packages required by strict TypeScript
  consumers and qualified the generated npm tarball in a clean project.

## 0.5.0 - 2026-07-31

- Replaced the hand-written executable argument parser with Commander 14 and
  moved k6 and Maestro command declarations into their adapter modules.
- Added the `@lucasacoutinho/tiacore/evidence` correlation SDK and Playwright
  request propagation so browser tests can own files executed by API and worker
  processes.
- Added an adapter-owned Gradle/JUnit entry point and CLI namespace for Java and
  Kotlin test-class selection, native Gradle execution, and JUnit completion
  validation.
- Added bounded executable certification and monorepo-scale protocol regression
  coverage using the existing Vitest Bench harness.

### Added

- Added differential verification through `tiacore verify` and
  `@lucasacoutinho/tiacore/verification`. It compares a normal selective run
  with a fresh full run across every participating runner and emits a
  machine-readable receipt for outcomes, dependency evidence, complete coverage
  evidence, executed and replayed counts, fallbacks, and measured speedup.
- Added provider-neutral artifact publishing through
  `@lucasacoutinho/tiacore/artifacts` and `tiacore artifacts publish|promote`,
  with custom sinks, filesystem output, SHA-256 integrity, source and parent
  lineage, explicit trust state, and coverage-aware promotion refusal.
- Added runtime baseline provenance and per-target selection decisions to run
  plans and replay lifecycle events, with bounded human-readable explanations
  across Vitest, Playwright, Node, and Bun.

### Changed

- Isolated package subpath shims and the CLI launcher under `src/entries`,
  leaving `src/index.ts` as the only source-root file.
- Replaced the monolithic README with a concise project overview and focused
  guides for setup, configuration, CI, parallelism, shards, and worktrees.

## 0.4.1 - 2026-07-31

### Fixed

- Ignored Bun's transient `.bun-build` files and failed closed instead of
  throwing when a relevant file becomes unreadable during a concurrent baseline
  snapshot.

## 0.4.0 - 2026-07-31

### Added

- Added an explicit `@lucasacoutinho/tiacore/vitest` entry point while
  preserving the root Vitest compatibility export.
- Added `@lucasacoutinho/tiacore/workspace` and `tiacore run` for bounded
  parallel command and adapter lanes with dependencies, fail-fast behavior, and
  resource locks.

### Changed

- Reorganized implementation code into protocol, engine, adapter, integration,
  orchestration, CLI, and public-contract boundaries.
- Grouped tests by unit and integration domain while retaining real runner and
  package fixtures.
- Centralized runtime lifecycle preparation across the runner-neutral core and
  Vitest adapter.

## 0.3.1 - 2026-07-30

### Fixed

- Scoped direct changed-test selection to each custom, Node, or Bun runner's
  declared test inventory so unrelated suites cannot leak across lanes.

## 0.3.0 - 2026-07-30

### Added

- Runtime test impact analysis for Vitest, Playwright, `node:test`, and
  `bun:test`.
- A versioned runner-neutral protocol, deterministic planner and merger,
  portable CLI, Maestro flow adapter, and k6 profile/import adapter.
- Per-test runtime dependency and Istanbul coverage graphs with cached replay.
- Exact Vitest case selection, conservative concurrent-test handling, Browser
  Mode, React Testing Library, lazy imports, asset edges, and multi-project
  support.
- Playwright file selection from browser source maps, lazy route chunks, and
  transitive spec/fixture imports while preserving native projects and workers.
  Chromium traces executed V8 ranges through large bundle maps; other engines
  retain conservative map-level attribution.
- Git and filesystem baselines, worktree-safe caches, transactional
  multi-process graph updates, and bounded runner parallelism.
- Provider-neutral artifact restoration, GitHub Actions discovery, shard
  fragments, and merged full-suite coverage.
- Framework adapters for runtime-selected database migrations and views.
- Native coverage configuration parity for include/exclude, zero-hit sources,
  cleaning, failed-test reporting, watermarks, reporter tuples, and thresholds.
- Compatibility and failure-injection suites for supported runtimes, Vite
  versions, package managers, workers, writers, shards, artifacts, and paths.
- ESM and CommonJS runtime and declaration exports for every public entry point.
- Provider-neutral private npm publication with an explicit public-registry
  refusal, plus generated-output-free VCS installs.
- Reproducible Bun VCS source builds that temporarily bootstrap the
  package-locked development toolchain before compiling uncommitted distribution
  output without shadowing consumer peer dependencies.

### Changed

- Completed the pre-release `tiacore` rename across reporter metadata,
  cross-process environment variables, Playwright attachments, shared symbols,
  fixtures, and test infrastructure. No legacy alias is retained because no
  tagged release or known consumer uses the old identifiers.
- Made protocol v1 bounded and canonical. Runtime validation now rejects unknown
  fields, duplicate relations, dependency cycles, unsafe paths, and oversized
  collections. Shipped schemas, an artifact-envelope validator, and
  language-independent golden planning and rejection vectors.
- Renamed the JavaScript-only cache type to `TiaRuntimeGraph` and documented its
  boundary from the portable `TiaImpactGraph` protocol.
- Added a capability-scoped adapter conformance catalog, strict certification
  receipt, public validation API, schema, and `tiacore certify adapter` CLI.
- Added executable `tia(options).run()` paths for k6 and Maestro with
  resource-lock scheduling and success-gated graph promotion.
- Added explicit subprocess ownership mappings and shared those framework edges
  with the Playwright runner for backend, database, and view sources.
- Added direct GitLab CI artifact discovery and a bounded, authenticated HTTP
  manifest provider suitable for Buildkite, Jenkins, and signed object-storage
  URLs.
- Added the first non-JavaScript SDK: a dependency-free Python pytest adapter
  certified against the shared protocol vectors and real file-selection
  fixtures.
- Added Python 3.10, 3.12, and 3.13 compatibility jobs and made the proprietary
  release gate build both npm and Python distributions.

### Known boundaries

- `thresholds.autoUpdate` is enforced but does not rewrite configuration.
- Code executed only in external subprocesses cannot be attributed
  automatically; stable ownership can be declared with a subprocess mapping.
- Watch mode and explicit Vitest selection flags remain owned by Vitest.
- Playwright sources without usable maps or direct project URLs remain unknown
  and conservatively expand to the full configured suite.
