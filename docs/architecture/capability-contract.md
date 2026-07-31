# Adapter capability contract

tiacore uses three capability levels. They prevent a static selector from
claiming the same guarantees as a runner that records executed code for each
test.

## Runtime TIA

A runtime TIA adapter records executed dependencies at test-case granularity,
selects affected cases, reruns previous failures, and reuses cached outcomes.
Coverage reconstruction is a separate capability and is not implied by this
level.

Vitest, `node:test`, and `bun:test` currently meet this level. Node 22.10
through 22.14 records an aggregate dependency set for every case in one file,
so those releases select conservatively even though replay still addresses
individual named cases.

Third-party TypeScript runtime adapters can implement this level through
`@usescherie/tiacore/adapter`. Certification remains required before an adapter
may claim the level; using the API alone is not certification.

## Observed file TIA

An observed-file adapter records runtime evidence but selects whole test files.
It may combine runtime evidence with static fixture or import relationships.
It does not claim cached test-case outcomes or reconstructed full-suite
coverage.

Playwright currently meets this level. Chromium records executed JavaScript
ranges through source maps. Other engines retain broader map-level evidence.

## Static impact selection

A static adapter discovers real suites and maps source or configuration files
to them without observing the runner's execution. A plan may mark an
unselected suite as cached, but that means only that its prior graph relation
is reusable. It does not replay a native runner result.

k6, Maestro, Gradle/JUnit, and the Python pytest SDK currently meet this level.
The Gradle adapter delegates all selected classes to one native Gradle task and
uses JUnit XML as completion evidence; it does not replay JVM outcomes.

## Rules shared by every level

- An unknown executable change selects the full authorized suite by default.
- A failed test or suite is never accepted as a successful cached result.
- An incomplete, corrupt, incompatible, or conflicting graph cannot authorize
  a skip.
- Git is optional. Adapters that own baseline discovery use a filesystem
  snapshot when Git cannot provide a usable commit.
- Resource locks constrain scheduling. They do not prove dependency edges.
- Each adapter declares its selection granularity, evidence type, baseline
  inputs, replay behavior, coverage behavior, and known boundaries.

The shipped
[`adapter-capabilities-v1.json`](../../capabilities/adapter-capabilities-v1.json)
file is the machine-readable contract. Its schema is
[`tiacore-adapter-capabilities-v1.schema.json`](../../schemas/tiacore-adapter-capabilities-v1.schema.json).
