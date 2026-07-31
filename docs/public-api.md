# Public API

tiacore has eleven primary supported entry points plus the Playwright reporter
configuration target. Everything below `dist/` or an internal `src/` folder is
private and may change without notice.

## `@usescherie/tiacore`

Remains a compatibility alias for `@usescherie/tiacore/vitest`. It exports
named and default `tia(options?)`, the Vitest plugin factory. Public
types cover:

- plugin, coverage, framework, artifact, and replay options;
- filesystem, GitHub Actions, GitLab CI, HTTP-manifest, and custom artifact
  providers;
- coverage thresholds, watermarks, and reporter tuples;
- replay lifecycle events and framework edge contexts.

The factory name is always `tia`; runner- or framework-prefixed variants are
not part of the API.

## `@usescherie/tiacore/vitest`

The explicit Vitest entry point. It has the same named and default `tia()`
factory and public option types as the root compatibility export. New Vitest
configurations should prefer this path.

The separately packaged Python SDK in `sdks/python` exports the same `tia`
factory for pytest. It is a protocol-v1 static-impact adapter and is not an npm
entry point.

## `@usescherie/tiacore/node` and `@usescherie/tiacore/bun`

Each exports named `tia(options?)`, returning a `TiaRunner` with an asynchronous
`run()` method. Both share `TiaRunnerOptions` and `TiaRunnerResult`. Node also
enforces its 22.10 runtime minimum when the adapter is executed.

## `@usescherie/tiacore/playwright`

Exports overloaded named `tia()`:

- `tia(baseTest)` returns a Playwright fixture that records browser source-map
  dependencies;
- `tia()` returns the reporter tuple appended to `reporter`;
- `tia(options)` returns a `TiaPlaywrightRunner` with an asynchronous `run()`
  method.

Public types include `TiaPlaywrightOptions`, `TiaPlaywrightResult`, and the
reporter tuple. Selection is conservative and file-level. Normal Playwright
workers, retries, projects, and dependency projects remain runner-owned. The
optional `name` assigns an independent graph to a lane when multiple lanes
share one Playwright config. Chromium uses executed JavaScript ranges for
source-map attribution; other browser engines use conservative map-level
attribution.
`frameworks` accepts the same database, view, subprocess, and custom edge
adapters as Vitest so browser specs can own backend or external-service files.

`@usescherie/tiacore/playwright/reporter` is a supported configuration target used by the
reporter tuple. Applications should obtain it through `tia()` instead of
constructing the path.

## `@usescherie/tiacore/core`

Exports `TiaCore`, `TiaCoreOptions`, and `TiaObservation` for authors building a
runner adapter. This is an advanced API: callers prepare a run plan, execute
the selected work, and commit normalized observations. They must preserve
whole-file fallback and failed-test rerun semantics.

Custom adapters should set `testFiles` to their project-relative suite paths or
globs. A changed test outside that inventory is not scheduled directly, while
an observed dependency edge from that file can still invalidate an in-scope
test. This keeps multiple runners and acceptance lanes isolated in one
repository.

`TiaRuntimeGraph` and `TiaRuntimeGraphPartition` describe the JavaScript SDK's
persisted runner cache. They are public so adapter authors can inspect a
successful commit, but their schema is not the portable language contract. A
schema change may force a safe cache rebuild during `0.x`.

It also exports the runner-neutral `createImpactPlan()` and
`mergeImpactGraphs()` functions plus protocol types.

## `@usescherie/tiacore/protocol`

Exports the versioned runner-neutral graph, suite, observation, change, policy,
plan, and artifact-envelope types. It also exports portable path normalization,
strict graph and artifact validation, and the version 1 resource limits. Paths
stored in the protocol are project-relative with forward slashes.

The protocol graph is `TiaImpactGraph`. It never contains JavaScript coverage
or cached native test results.

## `@usescherie/tiacore/conformance`

Exports the adapter scenario catalog, receipt types, strict receipt parser, and
`certifyAdapterReceipt()`. A receipt declares its capability level and optional
features. Certification requires every scenario that applies to those claims,
passing evidence, and at least one assertion per scenario.

The CLI exposes the same gate through:

```sh
tiacore certify adapter --receipt adapter-certification.json
```

## `@usescherie/tiacore/maestro`

Discovers real Maestro YAML flows, tags, and `runFlow` relationships. It exports
catalog fingerprinting, graph recording, impact planning, and `tia(options)`.
The returned runner executes selected flows and promotes its graph only after
the command succeeds. Every selected suite declares a device resource lock.

## `@usescherie/tiacore/k6`

Discovers real k6 profile entrypoints and follows their transitive local ESM
imports. It exports catalog fingerprinting, graph recording, lane-bounded
impact planning, and `tia(options)`. The returned runner executes selected
profiles and promotes its graph only after the command succeeds. Every selected
suite declares a performance-host resource lock.

## `@usescherie/tiacore/workspace`

Exports named `tia(options)`, `TiaWorkspaceRunner`, and workspace lane and
result types. A lane defines exactly one command or runner, optional
dependencies, and optional resource locks. Independent lanes run concurrently
up to the configured bound. Matching locks serialize lanes, failed dependencies
block downstream lanes, and `failFast` blocks pending work after the first
failure.

The workspace coordinator does not merge runner graphs or reinterpret cached
results. Each adapter remains responsible for its own impact plan and native
parallelism.

## Compatibility policy

Published releases follow Semantic Versioning. During `0.x`, a breaking public
API change increments the minor version. Internal cache schema changes may
force a safe full-suite rebuild and are not a public data-migration guarantee.
Portable graphs remain validated before reuse.
