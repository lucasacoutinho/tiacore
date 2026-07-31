# tiacore protocol version 1

Protocol version 1 exchanges deterministic impact graphs and volatile artifact
envelopes. SDK-specific coverage counters, cached native results, logs, and
credentials do not belong in the portable graph.

## Paths

Every stored path is relative to the project root and uses `/` separators.
Readers normalize repeated separators and leading `./` segments. Readers reject
empty paths, parent escapes, absolute Unix paths, Windows drive paths, URIs,
null bytes, and paths longer than 4,096 code units.

Path matching is case-sensitive in the protocol. An SDK may account for a
case-insensitive filesystem while collecting changes, but it must emit the
canonical project path before planning.

## Graph identity

`fingerprint` identifies the suite catalog and structural configuration.
`environmentFingerprint` identifies runner inputs that may change results
without changing project files. An empty environment fingerprint is valid when
the adapter has no environment-specific input.

`complete: false` means the graph cannot authorize selective execution or a
skip. A planner must select every suite allowed by policy.

## Suites and observations

Suite IDs are unique. Dependencies name other suites in the same graph and form
an acyclic graph. Selecting a suite also selects all of its dependencies.

An observation links one project path to one suite. Confidence and edge kind
describe why the relation exists; they do not weaken the safe fallback. Unknown
executable changes select the full authorized catalog unless policy explicitly
chooses the unsafe `ignore` behavior.

`knownSources` contains paths whose changes are known to be unrelated to every
suite. It does not create a cached native result.

## Canonical form

Readers return canonical graphs:

- suites sorted by ID;
- suite dependencies, resource locks, and tags sorted;
- observations sorted by suite ID, source, kind, and confidence;
- known sources normalized, deduplicated, and sorted;
- invalidators sorted by pattern and reason.

Duplicate suite IDs, observations, known sources, invalidators, dependencies,
resource locks, or tags are invalid. Unknown object fields are invalid in
version 1.

## Planning

The planner performs these checks in order:

1. Validate and restrict the catalog to suites allowed by policy.
2. Normalize changed paths.
3. Honor an explicit full-run policy.
4. Require a valid, complete graph.
5. Match the graph and environment fingerprints.
6. Apply structural invalidators.
7. Select changed suite files and observed dependencies.
8. Fall back to the full allowed catalog for an unknown change.
9. Add transitive suite dependencies.

The output sorts selected suites, cached suites, resource locks, changed files,
and per-suite reasons. `cached` means the prior impact relation is reusable.
Only an adapter capability contract may claim that it also replays native test
results.

## Artifact envelopes

An artifact envelope identifies its adapter, artifact, run, graph, and optional
partition. Partition indexes are one-based and cannot exceed `total`. Transport
implementations must apply their own byte and candidate-count limits before
decoding JSON.

The schemas under `schemas/` and vectors under `conformance/protocol/v1/` are
normative. A future implementation passes protocol conformance only when it
produces the exact expected plans and rejects every invalid vector.

## Resource limits

Version 1 readers enforce these maximums:

| Item                   |   Maximum |
| ---------------------- | --------: |
| Suites                 |   100,000 |
| Observations           | 1,000,000 |
| Known sources          | 1,000,000 |
| Invalidators           |    10,000 |
| Relations on one suite |   100,000 |
| Path length            |     4,096 |
| Other string length    |     8,192 |
