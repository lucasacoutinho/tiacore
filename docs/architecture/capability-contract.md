# Adapter capability contract

tiacore uses three capability levels. They prevent a static selector from
claiming the same guarantees as a runner that records executed code for each
test.

## Runtime TIA

A runtime TIA adapter records executed dependencies at test-case granularity,
selects affected cases, reruns previous failures, and reuses cached outcomes.
Coverage reconstruction is a separate capability and is not implied by this
level.

Vitest, `node:test`, and `bun:test` currently meet this level. Node 22.12
through 22.14 records an aggregate dependency set for every case in one file, so
those releases select conservatively even though replay still addresses
individual named cases.

Third-party TypeScript runtime adapters can implement this level through
`@lucasacoutinho/tiacore/adapter`. Certification remains required before an
adapter may claim the level; using the API alone is not certification.

## Observed file TIA

An observed-file adapter records runtime evidence but selects whole test files.
It may combine runtime evidence with static fixture or import relationships. It
does not claim cached test-case outcomes or reconstructed full-suite coverage.

Playwright currently meets this level. Chromium records executed JavaScript
ranges through source maps. Other engines retain broader map-level evidence.

## Static impact selection

A static adapter discovers real suites and maps source or configuration files to
them without observing the runner's execution. A plan may mark an unselected
suite as cached, but that means only that its prior graph relation is reusable.
It does not replay a native runner result.

k6, Maestro, Gradle/JUnit, the Python pytest SDK, and the Go SDK currently meet
this level. The Gradle adapter delegates all selected classes to one native
Gradle task and uses JUnit XML as completion evidence; it does not replay JVM
outcomes.

The Go adapter identifies test and compile-only packages from the native package
graph, follows transitive local imports, and delegates affected packages to
`go test`. Go's runner executes every test in a selected package and owns its
content-addressed build and test cache. tiacore neither stores nor replays those
native outcomes.

## Unsupported runners

Jest is not supported. tiacore ships no Jest adapter, and the capability levels
above do not apply to a Jest run.

A JavaScript or TypeScript runner can implement runtime test-case selection and
cached outcomes through `@lucasacoutinho/tiacore/adapter`. Certification remains
required before an adapter may claim Runtime TIA; using the API alone is not
certification. With no adapter, run the Jest suite outside tiacore. Version 1 of
the adapter contract does not cover observed-file selection or static impact
planning. See the [TypeScript adapter contract](../guides/custom-adapters.md).

## Rules shared by every level

- An unknown executable change selects the full authorized suite by default.
- A failed test or suite is never accepted as a successful cached result.
- An incomplete, corrupt, incompatible, or conflicting graph cannot authorize a
  skip.
- Git is optional. Adapters that own baseline discovery use a filesystem
  snapshot when Git cannot provide a usable commit.
- Resource locks constrain scheduling. They do not prove dependency edges.
- Each adapter declares its selection granularity, evidence type, baseline
  inputs, replay behavior, coverage behavior, and known boundaries.

The shipped
[`adapter-capabilities-v1.json`](../protocol/capabilities/adapter-capabilities-v1.json)
file is the machine-readable contract. Its schema is
[`tiacore-adapter-capabilities-v1.schema.json`](../protocol/schemas/tiacore-adapter-capabilities-v1.schema.json).

## Qualification gates

Capability claims are exercised at their native boundary:

- Vitest runs Node, jsdom, React Testing Library, Browser Mode, coverage,
  reporters, shards, and concurrent-worker fixtures.
- Playwright installs and runs Chromium against lazy browser modules,
  cross-process evidence, workers, selective files, failed-case persistence, and
  recovery.
- Node runs its real programmatic test and coverage APIs at the minimum,
  precise-discovery, and current supported releases. The cross-platform gate
  also executes a full record, replay, and changed-source cycle on Linux,
  Windows, and macOS.
- Bun certification runs supported Bun releases on Linux and the current Bun
  release on Windows and macOS.
- k6, Maestro, and Gradle tests execute their real command boundaries with
  fixture processes. Non-zero commands, missing JUnit output, and failed JUnit
  cases must not promote a graph.

The cross-platform workflow also exercises protocol path normalization,
source-map resolution, segmented storage, coverage merging, graph merging, and
the static adapter command boundaries. A platform job is evidence only when it
passes at the exact candidate revision.
