# Changelog

All notable changes to tiacore will be documented here. The project follows
Semantic Versioning once a version is published.

## Unreleased

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
