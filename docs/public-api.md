# Public API

tiajs has four supported entry points. Everything below `dist/` or an internal
`src/` folder is private and may change without notice.

## `tiajs`

Exports named and default `tia(options?)`, the Vitest plugin factory. Public
types cover:

- plugin, coverage, framework, artifact, and replay options;
- provider-neutral artifact candidates and providers;
- coverage thresholds, watermarks, and reporter tuples;
- replay lifecycle events and framework edge contexts.

The factory name is always `tia`; runner- or framework-prefixed variants are
not part of the API.

## `tiajs/node` and `tiajs/bun`

Each exports named `tia(options?)`, returning a `TiaRunner` with an asynchronous
`run()` method. Both share `TiaRunnerOptions` and `TiaRunnerResult`. Node also
enforces its 22.10 runtime minimum when the adapter is executed.

## `tiajs/core`

Exports `TiaCore`, `TiaCoreOptions`, and `TiaObservation` for authors building a
runner adapter. This is an advanced API: callers prepare a run plan, execute
the selected work, and commit normalized observations. They must preserve
whole-file fallback and failed-test rerun semantics.

## Compatibility policy

Published releases follow Semantic Versioning. During `0.x`, a breaking public
API change increments the minor version. Internal cache schema changes may
force a safe full-suite rebuild and are not a public data-migration guarantee.
Portable graphs remain validated before reuse.
