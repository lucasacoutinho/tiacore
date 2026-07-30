# HTTP artifact manifest v1

The HTTP manifest makes baseline discovery independent from a CI vendor. A
provider publishes one JSON document:

```json
{
  "version": 1,
  "artifacts": [
    {
      "id": "pipeline-42-shard-1",
      "url": "https://storage.example/tiacore-42-1.zip",
      "group": "pipeline-42",
      "fingerprint": "optional-structural-fingerprint",
      "runner": "optional-runner-namespace"
    }
  ]
}
```

Entries are ordered from most to least preferred. `url` may be absolute or
relative to the manifest. The archive contains `graph.json`,
`.tia/graph.json`, or the equivalent runner-namespaced path. `group` identifies
partial graphs produced by one pipeline so fragments from different runs are
never merged.

The consumer reads at most 1 MiB of manifest data, inspects at most 100 entries,
reads at most 25 MiB per archive, extracts only the expected graph entry in
memory, and validates the graph and structural fingerprint before reuse.
Authorization is forwarded to same-origin archive URLs only. Cross-origin
signed URLs receive no manifest authorization header.

The normative JSON shape is
[`tiacore-artifact-manifest-v1.schema.json`](../schemas/tiacore-artifact-manifest-v1.schema.json).
