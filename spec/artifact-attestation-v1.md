# Artifact attestation v1

Every archive created by the tiacore publisher contains `attestation.json`.
Runner-namespaced archives also contain `<runner>/attestation.json`. The
attestation authenticates the graph independently from the CI or storage
provider that transported it.

```json
{
  "version": 1,
  "algorithm": "Ed25519",
  "keyId": "release-2026",
  "claim": {
    "issuedAt": "2026-07-31T20:00:00.000Z",
    "expiresAt": "2026-08-07T20:00:00.000Z",
    "fingerprint": "structural-fingerprint",
    "graphSha256": "64-lowercase-hex-characters",
    "promoted": true,
    "runner": "node",
    "lineage": {
      "baseline": { "sha": "source-revision", "source": "git" },
      "parents": ["previous-artifact-id"],
      "producedAt": "2026-07-31T20:00:00.000Z",
      "producer": "ci-system-name",
      "runId": "pipeline-42"
    }
  },
  "signature": "base64url-ed25519-signature"
}
```

The signature input is the UTF-8 JSON encoding of the attestation without
`signature`. Object keys at every depth are sorted by Unicode code-point order;
array order is preserved. The signature uses Ed25519 with no pre-hash. The graph
digest covers the exact bytes of the selected `graph.json` archive entry.

A consumer verifies the signature before interpreting the graph as a baseline.
It then checks the graph digest, fingerprint, baseline SHA and source, runner,
validity window, and configured trust policy. Policies can restrict key IDs,
producers, baseline sources, maximum age, earliest issuance, and promoted
status. Unsigned artifacts are rejected unless `allowUnsigned` is explicitly
enabled.

Transport integrity such as HTTPS and the archive SHA-256 in the HTTP manifest
remains useful, but does not replace producer authentication. Key rotation uses
a new `keyId`; consumers may trust both keys during a bounded transition and
then set `notBefore` or remove the previous public key.

The normative JSON shape is
[`tiacore-artifact-attestation-v1.schema.json`](../schemas/tiacore-artifact-attestation-v1.schema.json).
