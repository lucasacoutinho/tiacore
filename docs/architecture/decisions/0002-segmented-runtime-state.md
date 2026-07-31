# ADR 0002: segmented runtime state

Status: accepted

## Context

The original JavaScript runtime cache stored every result, dependency edge,
and coverage shard in one `graph.json`. Any small update parsed and rewrote the
entire graph. File size, write amplification, corruption scope, and transaction
cost therefore grew with the full test fleet.

## Decision

Runtime state uses a small atomic `state.json` manifest and content-addressed
objects under `objects/`. The five unbounded records are divided into 64 stable
key buckets:

- collection coverage;
- collection dependency edges;
- cached results;
- test coverage;
- test dependency edges.

Each non-empty bucket is serialized independently and named by its SHA-256
digest. The manifest stores graph metadata and the ordered bucket references,
including digest, byte size, and entry count. Its generation is the digest of
the metadata and reference set.

Writers serialize and validate the complete proposed state before writing.
They create missing immutable objects, then atomically rename the new manifest
while holding the existing cross-process transaction lock. Unchanged buckets
reuse the same objects. Readers verify the manifest generation and every
referenced object's size, digest, domain, bucket, and entry count before
reconstructing a graph. Any missing, corrupt, oversized, or inconsistent part
returns no graph and causes a full run.

Unreferenced objects are retained for at least 24 hours so a reader that opened
the previous manifest cannot lose an object during a concurrent commit.
Best-effort collection removes older unreferenced objects. A fresh run removes
only the active manifest; old immutable objects may be reused by the next
commit or collected later.

## Consequences

The active transaction is one bounded manifest rename. A one-test result change
rewrites one result bucket instead of the complete graph, while baseline-only
updates reuse every record object. Runtime state is an internal SDK format and
can rebuild safely; published artifacts continue to carry one authenticated
portable `graph.json` inside their bounded archive.
