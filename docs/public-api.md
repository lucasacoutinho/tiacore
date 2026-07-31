# Public API

tiacore has sixteen primary supported entry points plus the Playwright reporter
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
- replay lifecycle events, baseline provenance, selection decisions, and
  framework edge contexts.

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

## `@usescherie/tiacore/evidence`

Exports named `tia(options?)`, returning a `TiaEvidence` correlation client.
It creates bounded correlation IDs and headers, carries correlation through
asynchronous service code, records project-relative files atomically, and
collects evidence emitted by other processes. Playwright uses the same API to
join a browser test with API or worker files reached by that test.

The default request header is `x-tiacore-correlation-id`. Set
`TIA_EVIDENCE_DIRECTORY` for all participating processes and optionally
`TIA_EVIDENCE_HEADER` when a deployment requires a different header. Evidence
is inert unless a directory is configured by the runner or application.

## `@usescherie/tiacore/gradle`

Exports named `tia(options)`, returning a `TiaGradleRunner`. The adapter
discovers Java and Kotlin test classes, follows transitive imports to local production
sources, selects affected classes, delegates their execution to one native
Gradle invocation, and validates that selected classes appear in JUnit XML.
Gradle continues to own task caching, workers, forks, and connected devices.

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

`RunPlan`, `RunPlanBaseline`, and `RunPlanDecision` describe the runtime
selection receipt. Baseline data distinguishes a local graph from a restored
artifact and includes its provider, artifact identifier, baseline kind, and
commit when available. Decisions identify a full run, exact test case, or whole
test file and list the reasons that selected it. `formatRunPlanDetails()` turns
that data into bounded human-readable log lines.

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

## `@usescherie/tiacore/adapter`

Exports named `tia(definition, options?)`, `TiaAdapter`, adapter API version 1,
and its discovery, catalog, execution, observation, option, and result types.
This is the stable extension boundary for a TypeScript runner that provides
runtime test-case evidence and cached outcomes.

Discovery returns stable test IDs and project-relative files without executing
test bodies. Execution receives the selected cases and returns complete
per-test dependency observations. Missing selected results, incomplete runs,
duplicate IDs, or invalid paths prevent graph commit. The adapter keeps native
control of workers and retries while the shared runtime owns baseline capture,
planning, artifacts, replay, verification, and transactional persistence.

See the [adapter guide](guides/custom-adapters.md) for the complete contract and
reference implementation.

## `@usescherie/tiacore/artifacts`

Exports named `tia(options)`, `TiaArtifactPublisher`, the filesystem sink
factory, artifact attestation helpers, and provider-neutral publisher, sink,
manifest, lineage, trust-policy, and receipt types. `publish()` accepts a
complete graph or a valid partition; `promote()` accepts only a complete
non-partition graph and can require complete coverage.

The publisher creates a bounded ZIP with an Ed25519 attestation, records its
byte size and SHA-256 digest, and emits an HTTP-manifest-v1 document with source
baseline, parent artifacts, producer, and run ID. Consumers reject unsigned
artifacts by default and can restrict key IDs, producers, age, baseline source,
and promotion state. The built-in filesystem sink produces files for any CI
upload mechanism. A custom sink only implements `put()` and can target object
storage or a CI-native artifact API.

The CLI exposes both states:

```sh
tiacore artifacts publish --cache-dir .tia/node \
  --artifact-id build-42 --run-id pipeline-42 \
  --signing-key-id release-2026

tiacore artifacts promote --cache-dir .tia/node \
  --artifact-id release-42 --run-id pipeline-42 --require-coverage \
  --signing-key-id release-2026
```

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

## `@usescherie/tiacore/verification`

Exports named `tia(options)`, `TiaVerifier`, and the verification receipt,
snapshot, phase, runner, and issue types. The verifier executes the supplied
command twice: once with normal selective behavior and once with `TIA_FRESH=1`.
It compares complete outcomes and dependency graphs, plus coverage graphs when
the runner declares complete coverage evidence. It independently derives the
tests required by each change from the union of the before and after dependency
graphs, and fails when the selective phase omitted any of them.

Receipts include selection accuracy, per-runner phase metrics, and a performance
summary with executed, replayed, and fallback counts, wall-time savings,
execution reduction, and measured speedup.

The CLI exposes the same differential gate:

```sh
tiacore verify --output .tia/verification.json -- npm test
```

Every TIA runner reached by the command writes an isolated phase snapshot. A
missing or duplicate runner snapshot fails verification, so a command may
safely cover multiple Vitest configurations or heterogeneous workspace lanes.

## Compatibility policy

Published releases follow Semantic Versioning. During `0.x`, a breaking public
API change increments the minor version. Internal cache schema changes may
force a safe full-suite rebuild and are not a public data-migration guarantee.
Portable graphs remain validated before reuse.
