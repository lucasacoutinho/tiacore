# Changelog

All notable changes to tiacore will be documented here. Published releases
follow Semantic Versioning.

## Unreleased

### Added

- Added a standalone Go SDK and CLI that records filesystem baselines, maps
  native package dependencies to protocol-v1 package suites, selects affected
  packages, and fails safely to the full Go suite when evidence is missing or
  incompatible.

### Changed

- Qualified the Go adapter without overstating replay: `go test` retains
  ownership of workers and its native build/test cache, while tiacore stores
  only dependency and baseline evidence.

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
- Added the stable TypeScript adapter API at `@usescherie/tiacore/adapter`.
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
- Added the `@usescherie/tiacore/evidence` correlation SDK and Playwright
  request propagation so browser tests can own files executed by API and worker
  processes.
- Added an adapter-owned Gradle/JUnit entry point and CLI namespace for Java and
  Kotlin test-class selection, native Gradle execution, and JUnit completion
  validation.
- Added bounded executable certification and Scherie-scale protocol regression
  coverage using the existing Vitest Bench harness.

### Added

- Added differential verification through `tiacore verify` and
  `@usescherie/tiacore/verification`. It compares a normal selective run with a
  fresh full run across every participating runner and emits a machine-readable
  receipt for outcomes, dependency evidence, complete coverage evidence,
  executed and replayed counts, fallbacks, and measured speedup.
- Added provider-neutral artifact publishing through
  `@usescherie/tiacore/artifacts` and `tiacore artifacts publish|promote`, with
  custom sinks, filesystem output, SHA-256 integrity, source and parent lineage,
  explicit trust state, and coverage-aware promotion refusal.
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

- Added an explicit `@usescherie/tiacore/vitest` entry point while preserving
  the root Vitest compatibility export.
- Added `@usescherie/tiacore/workspace` and `tiacore run` for bounded parallel
  command and adapter lanes with dependencies, fail-fast behavior, and resource
  locks.

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
