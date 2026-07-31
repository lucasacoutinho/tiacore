# CI, parallelism, shards, and worktrees

tiacore selection and native test parallelism solve different problems. TIA
reduces the work set; the runner still executes that set with its normal
workers. The workspace coordinator can run independent quality lanes at the
same time.

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
})
```

Candidates are validated for structure, environment, fingerprint, and ancestry
before reuse. An unavailable or incompatible provider falls through to the
next one and finally to a full run.

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
  - uses: actions/upload-artifact@v4
    if: always()
    with:
      name: tiacore
      path: .tia
      include-hidden-files: true
      if-no-files-found: ignore
```

A full Git history enables ancestry verification. Without a usable `HEAD`, the
engine falls back to a larger filesystem-content baseline.

## Vitest shards

Vitest `--shard=<index>/<total>` runs write isolated fragments under
`.tia/fragments/<group>/<index>-of-<total>/graph.json`. Set one stable group for
all shards in the same run:

```sh
TIA_FRESH=1 \
TIA_SHARD_GROUP="$CI_PIPELINE_ID" \
npx vitest run --shard=1/4
```

The graph is promoted only after every partition has the same group, baseline,
fingerprint, and partition count. Missing, mixed, corrupt, or conflicting sets
are ignored. Coverage thresholds run after the complete set is merged.

For CI matrices, publish each fragment under a unique artifact name. The
GitHub provider accepts an `artifactName` pattern; other systems can download
all fragment directories and use the filesystem provider. Custom providers
must assign the same `group` to candidates from one partition set.

## Runner and lane parallelism

- Vitest retains its native threads or forks.
- Playwright retains workers, projects, retries, and project dependencies.
- Node and Bun run separate files concurrently up to their adapter
  `concurrency` setting.
- Cases within one Node or Bun file stay sequential.
- The workspace adapter runs independent commands or adapters concurrently and
  serializes matching `resourceLocks`.

Use resource locks for scarce or stateful infrastructure such as Android
emulators, databases, ports, and performance hosts. A lock should name the
resource, not the test framework.

## Worktrees and concurrent writers

Each Git worktree uses its own `.tia` directory by default and can run at the
same time. Graphs restored between worktrees are reusable only when their
recorded commit is an ancestor of the target.

Graph commits use a short cross-process transaction. A writer locks the commit,
rereads the current generation, merges compatible disjoint changes, and
atomically renames the result. Conflicting updates fail closed without
overwriting the winning graph.

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
[`spec/artifact-manifest-v1.md`](../../spec/artifact-manifest-v1.md).
