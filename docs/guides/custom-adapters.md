# TypeScript adapter contract

`@lucasacoutinho/tiacore/adapter` is the supported boundary for a JavaScript or
TypeScript test runner that needs runtime test-case selection and cached
outcomes. Adapter code imports only this package entry point and constructs the
runner through `tia()`.

```ts
import {
  tia,
  TIA_TYPESCRIPT_ADAPTER_VERSION,
} from '@lucasacoutinho/tiacore/adapter'

const runner = tia(
  {
    apiVersion: TIA_TYPESCRIPT_ADAPTER_VERSION,
    name: 'acme-test',
    version: '2.4.0',
    features: ['cached-outcomes', 'parallelism'],

    async discover({ root }) {
      return {
        fingerprint: 'runner-config-v3',
        files: ['acme.config.ts'],
        tests: await discoverAcmeTests(root),
      }
    },

    async execute({ plan, root, tests, wholeTestFiles }) {
      const nativeResults = await runAcme({
        root,
        tests,
        wholeTestFiles,
      })

      return {
        complete: nativeResults.processExitedNormally,
        fullyExecutedFiles: nativeResults.completeFiles,
        observations: nativeResults.tests.map((test) => ({
          id: test.id,
          file: test.file,
          fullName: test.fullName,
          state: test.state,
          duration: test.duration,
          files: test.filesReached,
        })),
      }
    },
  },
  {
    cacheDir: '.tia',
    onUnknownChange: 'full',
  },
)

const result = await runner.run()
process.exitCode = result.success ? 0 : 1
```

## Discovery contract

Discovery runs before planning and must not execute test bodies. It returns a
stable ID, project-relative test file, and display name for every owned test.
`files` lists runner configuration or catalog inputs that affect discovery.
`fingerprint` covers inputs that cannot be represented by those paths, such as a
remote schema version.

Test IDs must be unique and stable across runs. Paths use forward slashes and
cannot escape the project. A changed catalog, adapter version, file inventory,
or fingerprint invalidates the graph and records the full suite.

## Execution contract

The execution callback receives only the selected tests. A test sourced from
`baseline` existed in the previous graph but not the current catalog; the
adapter should attempt it using the supplied ID, file, and name so a stale or
failed case cannot disappear silently.

Every selected test needs one observation. `files` is the runtime dependency set
reached by that test. Set `complete` only when discovery and the native runner
finished without losing results. Declare a file in `fullyExecutedFiles` only
when every test it currently contains ran. Missing observations, duplicate IDs,
invalid paths, or incomplete execution prevent graph commit. Failed observations
are committed so they are forced to rerun next time.

The adapter owns native workers, filters, retries, and process management. TIA
owns baseline comparison, conservative fallback, cached failures, artifact
restoration, replay events, verification snapshots, and transactional graph
commit.

## Scope

Version 1 is a runtime test-case contract. It does not claim Istanbul coverage
reconstruction, partitions, observed-file selection, or static protocol
planning. Those capabilities require their dedicated public APIs until a later
adapter-contract version defines the needed evidence precisely.

Before shipping an adapter, run differential verification on real fixtures and
produce an adapter conformance receipt. The public fixture in
`test/fixtures/custom-adapter` is the package-level reference implementation.
