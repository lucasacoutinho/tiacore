# Target architecture

tiacore is organized around one portable contract and several runner-native
adapters. The target is a layered system, not a single executable that every
language must embed.

```text
public entry points and CLI
          |
          v
adapters and workspace orchestration
          |
          v
JavaScript runtime engine and integrations
          |
          v
portable protocol, schemas, and conformance vectors
```

## Layer responsibilities

`protocol` owns the versioned `TiaImpactGraph`, path rules, validation,
deterministic planning, and merging. It cannot depend on JavaScript runner or
coverage state.

`engine` owns baseline capture, structural fingerprints, runtime planning,
cached outcomes, coverage shards, transactional persistence, partitions,
artifacts, replay events, and bounded scheduling. Its `TiaRuntimeGraph` is an
SDK cache, not a cross-language format.

Runtime persistence is segmented: a bounded `state.json` atomically references
content-addressed record buckets. Small updates reuse unchanged buckets instead
of rewriting a monolithic graph.

`adapters` own runner APIs and translate discovery, execution, dependencies,
results, and failures into engine observations or portable protocol graphs.
Runner-specific policy stays here.

`integrations` own evidence sources shared by adapters, currently Istanbul
coverage and database, view, subprocess, and custom framework edges.

`orchestration` owns cross-lane concurrency, dependencies, failure propagation,
and resource locks. It never decides which tests are affected.

`cli` composes the executable with Commander and registers only
runner-neutral commands. Each adapter owns its Commander registrar beside its
implementation, so runner vocabulary and options do not accumulate in a
central dispatch table. The executable invokes protocol, adapter, or
orchestration APIs without reimplementing argument parsing.
`entries` contains thin package shims and the executable launcher. The source
root contains only the default `index.ts` entry. `test/unit` mirrors
component boundaries; `test/integration` proves real runner, storage, CLI, and
package behavior; `test/fixtures` contains reusable real projects.

## Dependency rules

- Protocol code has no dependency on engine, adapters, integrations, or CLI.
- Engine code may depend on protocol and low-level shared utilities.
- Adapters may depend on engine and integrations.
- Orchestration may invoke public runner contracts but does not import runner
  internals.
- CLI code may compose protocol, adapters, and orchestration.
- Adapter commands are declared in the adapter layer and registered by the CLI;
  the core CLI may not switch on adapter-prefixed command names.
- Public entry points expose supported contracts without exporting internal
  paths.
- External TypeScript runner adapters enter through the versioned `adapter`
  contract and the `tia()` factory, not through internal engine modules.

## Language boundary

The root npm package remains the JavaScript SDK while exact VCS installation is
supported. Other SDKs live under `sdks/<language>`, implement protocol version
1, and pass the shared conformance vectors. A native or WASM core is not a
requirement. It becomes justified only if multiple conforming implementations
show that distributing one planner is cheaper and safer than maintaining them.

## Completion criteria

The structure is complete when every runner has a named adapter boundary, the
runtime lifecycle is shared rather than copied, public entry points are thin,
tests mirror the domains, workspace coordination remains runner-neutral, and
JavaScript, Python, packaging, path, benchmark, and self-TIA checks pass.
