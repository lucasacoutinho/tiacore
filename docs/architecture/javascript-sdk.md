# JavaScript SDK boundary

The repository currently ships one npm package, `@usescherie/tiacore`. That
package is the JavaScript SDK. It owns integrations with Vitest, Vite,
Istanbul, Playwright, Node, Bun, k6, and Maestro.

Its physical boundaries are explicit:

- `protocol` defines portable data and deterministic planning behavior;
- `engine` owns JavaScript baselines, runtime plans, replay, persistence, and
  scheduling;
- `adapters` translate runner-native discovery and results;
- `integrations` add coverage and framework-specific dependency evidence;
- `orchestration` schedules independent adapter or command lanes;
- `cli` assembles Commander registrars for protocol, adapter, and orchestration
  operations. Adapter-specific command declarations remain under `adapters`.

Supported subpath entry points stay as thin files in `src/entries/`; only the
default compatibility entry remains at `src/index.ts`. Internal modules are
not package exports.

The repository name is broader than the package implementation because the
portable protocol and conformance vectors are intended for other language
SDKs. Those SDKs do not import JavaScript runner state.

## Two graph types

`TiaImpactGraph` is the portable protocol graph. It contains suites,
dependency observations, structural invalidators, environment identity, and
resource locks. Its version 1 schema and conformance vectors are public
contracts.

`TiaRuntimeGraph` is the JavaScript SDK cache graph. It stores:

- cached Vitest, Node, and Bun outcomes;
- per-test and collection-level dependency edges;
- Istanbul coverage shards;
- Git or filesystem baseline data;
- JavaScript shard metadata.

The runtime graph may rebuild when its internal schema changes. It must not
cross into a future non-JavaScript SDK as if it were a portable format.

## Conversion boundary

Runner adapters follow one of two paths.

Vitest, Playwright, Node, and Bun use `TiaCore` and the JavaScript runtime graph
because they need cached native results and JavaScript coverage.

k6 and Maestro currently emit `TiaImpactGraph` directly because they provide
static impact selection and do not replay native runner results.

The workspace coordinator composes adapter runners without becoming another
impact engine. Each lane keeps its own graph, selection semantics, and native
parallelism. The coordinator owns only cross-lane concurrency, dependencies,
failure propagation, and resource locks.

The Python pytest SDK under `sdks/python` proves the protocol boundary is
language-neutral. Its planner is certified against the same JSON vectors and
emits the same `TiaImpactGraph` shape without importing JavaScript.

A future adapter that needs JavaScript replay may use `TiaCore`. Every language
SDK must implement protocol version 1 and pass the conformance vectors without
reading `TiaRuntimeGraph`.

## Package layout decision

The JavaScript SDK remains at the repository root while exact VCS installation
is an active delivery method. Moving it into a workspace package would break
that simple installation path or require a repository-specific bootstrap.

When a second language SDK exists, it may live under `sdks/<language>` without
moving the npm package. We will reconsider a monorepo-wide package move only
when a real consumer makes the asymmetry costly.
