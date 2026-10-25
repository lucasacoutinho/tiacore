# CI, parallelism, shards, and worktrees

tiacore selection and native test parallelism solve different problems. TIA
reduces the work set; the runner still executes that set with its normal
workers. The workspace coordinator can run independent quality lanes at the same
time.

## Fast first runs

A commit-specific cache key alone speeds up only later jobs that can restore a
prefix match. To accelerate the first run on a new branch, restore a compatible
graph from an ancestor commit or from the branch it forked from.

Artifact discovery is provider-neutral. A CI system can download graphs itself
and use the filesystem provider:

```ts
tia({
  artifacts: {
    provider: 'filesystem',
    paths: ['.tia-artifacts'],
  },
})
```

Direct providers are available for GitHub Actions and GitLab CI. The HTTP
manifest supports Buildkite, CircleCI, Jenkins, object storage, and other
systems that can publish a bounded manifest and archive:

```ts
tia({
  artifacts: [
    { provider: 'filesystem', paths: ['.tia-artifacts'] },
    { provider: 'gitlab-ci', jobName: 'tiacore-*' },
    {
      provider: 'http-manifest',
      url: 'https://ci.example/tiacore/manifest.json',
      tokenEnv: 'TIA_ARTIFACT_TOKEN',
    },
  ],
  artifactTrust: {
    publicKeys: {
      'release-2026': process.env.TIA_ARTIFACT_PUBLIC_KEY!,
    },
    allowedProducers: ['release-ci'],
    maxAgeSeconds: 604800,
  },
})
```

Candidates are validated for structure, environment, fingerprint, and ancestry
before reuse. An unavailable or incompatible provider falls through to the next
one and finally to a full run.

## Publish without a CI-vendor adapter

Create a portable archive and manifest after a successful lane:

```sh
npx tiacore artifacts publish \
  --cache-dir .tia/playwright-feature \
  --artifact-id "$CI_JOB_ID" \
  --run-id "$CI_PIPELINE_ID" \
  --producer release-ci \
  --signing-key-id release-2026 \
  --runner playwright-feature \
  --output-dir .tia-artifacts/playwright-feature
```

The command reads the Ed25519 private key from `TIA_ARTIFACT_PRIVATE_KEY`. Use
`--signing-key-env` to select another secret variable and `--trust-expires-in`
to set a bounded lifetime. Keep the PKCS#8 private PEM only in the producing
system and distribute the SPKI public PEM to consumers.

Upload `.tia-artifacts/playwright-feature` with the CI system's normal artifact
step or sync it to object storage. The manifest carries archive integrity,
source-baseline lineage, producing run, and optional parent IDs. The archive's
Ed25519 attestation authenticates the exact graph and those trust properties.
For a custom destination, pass a sink implementing the public `put()` contract
to `@lucasacoutinho/tiacore/artifacts`.

Use `artifacts promote` only at a trusted baseline boundary. It refuses partial
graphs; `--require-coverage` also refuses a graph without complete reconstructed
coverage. HTTP consumers can set `promotedOnly: true` when bootstrapping a
release lane. Promotion is an authenticated claim, not a trusted boolean read
from an unverified manifest. Publishing and promotion remain independent from
GitHub, GitLab, or any branch name.

## Retention of the artifact directory

A directory that lives across runs, such as a cached `.tia-artifacts`, would
grow by one archive per publish. The filesystem sink therefore prunes it after
it writes `manifest.json`, which is the last write of a publish. With no setting
it keeps these archives and deletes the rest:

- the 20 newest archives, by modification time. A store that resets modification
  times when it restores files, such as an artifact download, ranks them by
  restore time;
- every archive the manifest lists, including one a concurrent publish listed;
- for each runner and fingerprint, the newest unexpired promoted archive that
  would otherwise be deleted. Restore with `requirePromoted` depends on it. A
  promoted archive that is already among the 20 newest can leave one older
  promoted archive behind until it falls out of the window too. At most 32
  archives are kept this way, because the code that prunes does not check
  signatures.

Only files named `tiacore-<24 hex digits>.zip` directly in the directory are
candidates. Other files and subdirectories stay. A prune that fails for any
reason leaves the archives where they are and does not fail the publish.

```ts
import { tia } from '@lucasacoutinho/tiacore/artifacts'

tia({
  // ...
  filesystem: {
    directory: '.tia-artifacts',
    retention: { keep: 50, maxAgeDays: 30 },
  },
})
```

`createFilesystemArtifactSink({ retention })` takes the same setting for a sink
you pass to `sink`. `keep` is a positive integer. `maxAgeDays` also deletes
archives last written longer ago than that, even within the newest `keep`.
Archives the rules above keep stay either way. `retention: false` keeps every
archive. The CLI has `--keep <count>`, `--max-age-days <days>` and `--no-prune`.

Pruning is safe next to a reader because of two choices:

- An archive written in the last 10 minutes is never deleted. A second publish
  into the same directory writes its archive before its manifest, and for that
  gap nothing lists the archive. A reader that listed the directory a moment ago
  may also be about to open it.
- A reader already copes with an archive that disappears. The filesystem
  provider skips a file it can no longer open and uses the other candidates, or
  runs the full suite when none is left. Restore is an optimization, so the
  worst result of losing a race is more tests, never fewer. On Windows a file a
  reader holds open cannot be deleted. It stays until the next publish.

The sink reads the manifest from disk after it writes its own, so it also keeps
what a concurrent publish listed. It does not check again right before each
delete. That check would not be atomic, and the grace period covers the same
window.

Sharded runs publish one archive per shard. When several runs share one
directory, set `keep` to at least the shards per run times the runs you want to
keep, or the newest run can lose some of its fragments and cannot be merged.

The GitHub Actions, GitLab CI and HTTP manifest providers need no retention
setting. They only download. The CI system or the object store that holds the
files decides how long they live.

## GitHub Actions example

Use a unique key per commit with a restore prefix:

```yaml
- uses: actions/cache@v4
  with:
    path: .tia
    key: tiacore-${{ runner.os }}-${{ github.sha }}
    restore-keys: |
      tiacore-${{ runner.os }}-

- run: npm test
```

GitHub caches are immutable. A lockfile-only key would keep restoring the first
graph saved under that key.

The direct artifact provider can search recent ancestral runs:

```ts
tia({ artifacts: { provider: 'github-actions' } })
```

```yaml
permissions:
  actions: read
  contents: read

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  - run: npm ci
  - run: npm test
    env:
      GITHUB_TOKEN: ${{ github.token }}
  - run: >-
      npx tiacore artifacts publish --cache-dir .tia --artifact-id ${{
      github.run_id }} --run-id ${{ github.run_id }} --producer github-actions
      --signing-key-id release-2026
    env:
      TIA_ARTIFACT_PRIVATE_KEY: ${{ secrets.TIA_ARTIFACT_PRIVATE_KEY }}
  - uses: actions/upload-artifact@v4
    if: always()
    with:
      name: tiacore
      path: .tia-artifacts
      include-hidden-files: true
      if-no-files-found: ignore
```

A full Git history enables ancestry verification. Without a usable `HEAD`, the
engine falls back to a larger filesystem-content baseline.

## Vitest shards

Vitest `--shard=<index>/<total>` runs write isolated fragments under
`.tia/fragments/<group>/<index>-of-<total>/state.json`. Set one stable group for
all shards in the same run:

```sh
TIA_FRESH=1 \
TIA_SHARD_GROUP="$CI_PIPELINE_ID" \
npx vitest run --shard=1/4
```

The graph is promoted only after every partition has the same group, baseline,
fingerprint, and partition count. Missing, mixed, corrupt, or conflicting sets
are ignored. Coverage thresholds run after the complete set is merged.

For CI matrices, publish each fragment under a unique artifact name. The GitHub
provider accepts an `artifactName` pattern; other systems can download all
fragment directories and use the filesystem provider. Custom providers must
assign the same `group` to candidates from one partition set.

## Runner and lane parallelism

- Vitest retains its native threads or forks.
- Playwright retains workers, projects, retries, and project dependencies.
- Node and Bun run separate files concurrently up to their adapter `concurrency`
  setting.
- Cases within one Node or Bun file stay sequential.
- The workspace adapter runs independent commands or adapters concurrently and
  serializes matching `resourceLocks`.

Use resource locks for scarce or stateful infrastructure such as Android
emulators, databases, ports, and performance hosts. A lock should name the
resource, not the test framework.

## Cross-process evidence

Browser tests can attribute API and worker code reached during one test by
sharing a bounded correlation directory:

```ts
// Playwright runner
await tia({
  config: 'playwright.config.ts',
  evidenceDirectory: '.tia/evidence/playwright',
  root: process.cwd(),
}).run()

// API or worker process
const evidence = tia({
  directory: process.env.TIA_EVIDENCE_DIRECTORY,
  producer: 'api',
  root: process.cwd(),
})
const correlationId = evidence.fromHeaders(request.headers)
if (correlationId) {
  await evidence.run(correlationId, () => evidence.record(filesReached))
}
```

The Playwright fixture adds the correlation header to browser requests and
merges emitted files into that spec's dependency attachment. Give concurrent
lanes separate evidence directories. The collector ignores malformed, oversized,
and symlinked events rather than trusting arbitrary filesystem content.

## Platform qualification

The release gate runs the real Node adapter plus storage, path, source-map,
coverage, k6, Maestro, and Gradle boundary tests on Linux, Windows, and macOS.
Bun runs on all three systems in the compatibility workflow. Chromium-backed
Playwright and Vitest Browser Mode have a dedicated job that installs the
browser explicitly instead of relying on a runner image.

Do not infer platform support from path-string unit tests alone. The native
record, replay, changed-file, command-failure, and process-spawn paths must pass
at the exact release candidate.

## Worktrees and concurrent writers

Each Git worktree uses its own `.tia` directory by default and can run at the
same time. Graphs restored between worktrees are reusable only when their
recorded commit is an ancestor of the target.

Graph commits use a short cross-process transaction. A writer locks the commit,
rereads the current generation, merges compatible disjoint changes, writes only
changed content-addressed buckets, and atomically swaps the bounded state
manifest. Conflicting updates fail closed without overwriting the winning state.

An absolute shared `cacheDir` is safe for identical worktree states. Diverged
worktrees should keep separate caches because they cannot share one current
baseline.

## Promotion policy

Normal branch and release-candidate jobs should restore the newest compatible
ancestral graph and run affected work. Use a deliberate full run only at a
trusted promotion boundary:

```sh
TIA_FRESH=1 npm test
```

Upload that successful graph as the new baseline for following branches. This
keeps first branch runs fast without allowing an incomplete partial graph to
become the release baseline.

The vendor-neutral artifact manifest is specified in
[`docs/protocol/artifact-manifest-v1.md`](../protocol/artifact-manifest-v1.md).
The signed archive claim is specified in
[`docs/protocol/artifact-attestation-v1.md`](../protocol/artifact-attestation-v1.md).
