# HTTP artifact manifest v1

The HTTP manifest makes baseline discovery independent from a CI vendor. A
provider publishes one JSON document:

```json
{
  "version": 1,
  "generatedAt": "2026-07-31T20:00:00.000Z",
  "artifacts": [
    {
      "id": "pipeline-42-shard-1",
      "url": "https://storage.example/tiacore-42-1.zip",
      "group": "pipeline-42",
      "fingerprint": "structural-fingerprint",
      "runner": "optional-runner-namespace",
      "promoted": true,
      "sha256": "64-lowercase-hex-characters",
      "size": 12345,
      "lineage": {
        "baseline": { "sha": "source-revision", "source": "git" },
        "parents": ["previous-artifact-id"],
        "producedAt": "2026-07-31T20:00:00.000Z",
        "producer": "ci-system-name",
        "runId": "pipeline-42"
      }
    }
  ]
}
```

Entries are ordered from most to least preferred. `url` may be absolute or
relative to the manifest. The archive contains `graph.json`,
`.tia/graph.json`, or the equivalent runner-namespaced path. `group` identifies
partial graphs produced by one pipeline so fragments from different runs are
never merged.

Publisher archives also contain a provider-neutral Ed25519 attestation. The
attestation authenticates the exact graph bytes and their lineage even when an
untrusted manifest or CI API supplies the download URL. See
[`artifact-attestation-v1.md`](artifact-attestation-v1.md).

Publishers set `promoted` only for a complete, non-partition graph. Consumers
may require promoted entries at release or branch-bootstrap boundaries. The
SHA-256 digest and byte size cover the archive exactly. `lineage` binds the
artifact to its source baseline, producing run, optional producer, and parent
artifact identifiers.

The consumer reads at most 1 MiB of manifest data, inspects at most 100 entries,
reads at most 25 MiB per archive, extracts only the expected graph entry in
memory, and validates the graph and structural fingerprint before reuse.
Authorization is forwarded to same-origin archive URLs only. Cross-origin
signed URLs receive no manifest authorization header.

The normative JSON shape is
[`tiacore-artifact-manifest-v1.schema.json`](../schemas/tiacore-artifact-manifest-v1.schema.json).
