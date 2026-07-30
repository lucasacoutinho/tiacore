# Public API

tiacore has eight supported entry points. Everything below `dist/` or an
internal `src/` folder is private and may change without notice.

## `@usescherie/tiacore`

Exports named and default `tia(options?)`, the Vitest plugin factory. Public
types cover:

- plugin, coverage, framework, artifact, and replay options;
- provider-neutral artifact candidates and providers;
- coverage thresholds, watermarks, and reporter tuples;
- replay lifecycle events and framework edge contexts.

The factory name is always `tia`; runner- or framework-prefixed variants are
not part of the API.

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

`@usescherie/tiacore/playwright/reporter` is a supported configuration target used by the
reporter tuple. Applications should obtain it through `tia()` instead of
constructing the path.

## `@usescherie/tiacore/core`

Exports `TiaCore`, `TiaCoreOptions`, and `TiaObservation` for authors building a
runner adapter. This is an advanced API: callers prepare a run plan, execute
the selected work, and commit normalized observations. They must preserve
whole-file fallback and failed-test rerun semantics.

It also exports the runner-neutral `createImpactPlan()` and
`mergeImpactGraphs()` functions plus protocol types.

## `@usescherie/tiacore/protocol`

Exports the versioned runner-neutral graph, suite, observation, change, policy,
plan, and artifact-envelope types. It also exports portable path normalization
and strict graph validation. Paths stored in the protocol are project-relative
with forward slashes.

## `@usescherie/tiacore/maestro`

Discovers real Maestro YAML flows, tags, and `runFlow` relationships. It exports
catalog fingerprinting, graph recording, and impact planning. Every selected
suite declares a device resource lock.

## `@usescherie/tiacore/k6`

Discovers real k6 profile entrypoints and follows their transitive local ESM
imports. It exports catalog fingerprinting, graph recording, and lane-bounded
impact planning. Every selected suite declares a performance-host resource
lock.

## Compatibility policy

Published releases follow Semantic Versioning. During `0.x`, a breaking public
API change increments the minor version. Internal cache schema changes may
force a safe full-suite rebuild and are not a public data-migration guarantee.
Portable graphs remain validated before reuse.
