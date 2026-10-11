# ADR 0003: deduplicated runtime coverage

Status: accepted

## Context

Runtime graph schema 3 stored a complete Istanbul file coverage object for every
file that each test and test-file collection window touched. Each object
repeated the file's static statement, function, and branch maps. Stored bytes
therefore grew with tests × touched files × source size, although the maps
change only when the source changes.

A synthetic project with 30 source files and 96 tests stored 229,507,873 bytes,
about 2.39 MB per test. That size hit three limits:

- `writeSegmentedState` rejects a bucket over 20 MiB, so a domain holds at most
  about 1.34 GB in 64 buckets. At 2.39 MB per test, a suite of roughly 550 tests
  overflows.
- `graphDigest`, artifact publication, and verification snapshots serialized the
  whole graph into one string. V8 rejects strings above about 512 MiB, which is
  roughly 220 tests of the same shape.
- Replay start-up parsed every repeated map into memory before planning.

Large integration lanes, such as an API suite with about 400 test files whose
tests touch most of one application graph, exceed these limits by an order of
magnitude.

## Decision

Runtime graph schema 4 stores each static coverage map once:

- `TiaRuntimeGraph.coverageMaps` maps a content digest to one file template: the
  statement, function, and branch maps plus zeroed counters. The digest is
  SHA-256 over the template JSON. It does not include absolute paths, so equal
  sources share a map across checkouts and machines.
- `testCoverage` and `collectionCoverage` records hold only advanced counters
  per project-relative file and name their template with `map`. Statement and
  function counters appear only when nonzero. A branch appears with all of its
  path counters when any path advanced.
- The segmented store adds a `coverageMaps` domain and writes only maps that a
  record names. Its store version becomes 2. A record that names a missing map
  invalidates the whole graph.
- A graph digest is the manifest generation that the segmented store would
  record for the graph. It is computed one bucket at a time, so no caller
  serializes a whole graph into one string.
- Graph copies share the immutable maps and copy only the table. Coverage
  reports sum counters per file and map, then expand each map once.

The store and graph schema version changes make older stores fail manifest
validation. TIA then records a fresh baseline instead of reading them.
Unreferenced version 1 objects stay until the existing 24-hour collection.

## Artifact and snapshot boundaries

Published artifact `graph.json` keeps the schema-3 layout and the 20 MiB limit.
Publication expands records piece by piece and stops at the limit; restore
accepts schema-3 artifacts and compacts them. This keeps artifacts exchangeable
with earlier releases. It also means a graph whose expanded form exceeds 20 MiB
still cannot be published. Changing that needs a separately versioned artifact
graph format.

Verification snapshot version 1 is a frozen contract, and its `graph` field
carries a runtime graph whose schema may change. Snapshots therefore keep
version 1, embed the schema-4 graph, and write it one record at a time. The
verifier accepts embedded schema-3 and schema-4 graphs. It still parses each
snapshot file as one document. Keeping the snapshot graph in a sibling runtime
store would need a new snapshot contract version.

## Consequences

On the same 30-file project, stored state drops to 783,684 bytes, about 8.2 KB
per test. Edges, test edges, results, expanded coverage, and the reconstructed
coverage report stay identical to schema 3. A 640-test project whose schema-3
maps alone would need more than 1.6 GB stores about 6.3 MB.

The first run after an upgrade records a full baseline. `TiaRuntimeGraph`
consumers that read coverage must resolve `map` through `coverageMaps`, as
documented for the public in-memory type.
