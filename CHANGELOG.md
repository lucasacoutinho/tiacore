# Changelog

All notable changes to tiacore will be documented here. The project follows
Semantic Versioning once a version is published.

## Unreleased

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
  custom sinks, filesystem output, SHA-256 integrity, source and parent
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
  throwing when a relevant file becomes unreadable during a concurrent
  baseline snapshot.

## 0.4.0 - 2026-07-31

### Added

- Added an explicit `@usescherie/tiacore/vitest` entry point while preserving
  the root Vitest compatibility export.
- Added `@usescherie/tiacore/workspace` and `tiacore run` for bounded parallel
  command and adapter lanes with dependencies, fail-fast behavior, and
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
- ESM and CommonJS runtime and declaration exports for every public entry
  point.
- Provider-neutral private npm publication with an explicit public-registry
  refusal, plus generated-output-free VCS installs.
- Reproducible Bun VCS source builds that temporarily bootstrap the
  package-locked development toolchain before compiling uncommitted
  distribution output without shadowing consumer peer dependencies.

### Changed

- Completed the pre-release `tiacore` rename across reporter metadata,
  cross-process environment variables, Playwright attachments, shared symbols,
  fixtures, and test infrastructure. No legacy alias is retained because no
  tagged release or known consumer uses the old identifiers.
- Made protocol v1 bounded and canonical. Runtime validation now rejects
  unknown fields, duplicate relations, dependency cycles, unsafe paths, and
  oversized collections. Shipped schemas, an artifact-envelope validator, and
  language-independent golden planning and rejection vectors.
- Renamed the JavaScript-only cache type to `TiaRuntimeGraph` and documented
  its boundary from the portable `TiaImpactGraph` protocol.
- Added a capability-scoped adapter conformance catalog, strict certification
  receipt, public validation API, schema, and `tiacore certify adapter` CLI.
- Added executable `tia(options).run()` paths for k6 and Maestro with
  resource-lock scheduling and success-gated graph promotion.
- Added explicit subprocess ownership mappings and shared those framework
  edges with the Playwright runner for backend, database, and view sources.
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
