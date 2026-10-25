import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, test } from 'vitest'

import { tia } from '../../src/engine/artifacts/publish.ts'
import { disposeHost } from '../../src/host/runtime.ts'
import { assertNoLeak } from '../support/leak.ts'
import {
  graph,
  privateKeyPem,
  temporaryRoot,
  writeStored,
} from '../artifacts/support.ts'

// NF-MEM: publishing builds a zip, signs it and rewrites a manifest. A CI
// agent that publishes after every run must not grow, in memory or on disk.

afterAll(disposeHost)

describe('artifact publishing', () => {
  test('publishing again retains nothing in memory and adds exactly one archive', async () => {
    const root = temporaryRoot('tiacore-publish-leak-')
    const cacheDir = join(root, '.tia/node')
    await writeStored(
      cacheDir,
      graph('node-22-linux', {
        baseline: { sha: 'baseline-abc', source: 'git', workingTree: {} },
      }),
    )
    const publisher = tia({
      artifactId: 'build-1',
      cacheDir: '.tia/node',
      filesystem: { baseUrl: 'https://artifacts.example/tia' },
      producer: 'leak-test',
      root,
      runId: 'run-1',
      runner: 'node',
      signing: { keyId: 'leak-key', privateKey: privateKeyPem },
    })
    await publisher.promote()
    const output = join(root, '.tia-artifacts')
    let publishes = 1
    const result = await assertNoLeak(
      async () => {
        publishes += 1
        await publisher.promote()
      },
      { batches: 3, bytesPerOperation: 32_768, iterations: 15 },
    )
    expect(result.bytesPerOperation).toBeLessThan(32_768)
    // Every archive is kept, because the manifest's lineage names the earlier
    // ones (a documented property of the sink); the manifest stays one file.
    const files = readdirSync(output)
    expect(files.filter((name) => name.endsWith('.zip'))).toHaveLength(
      publishes,
    )
    expect(files.filter((name) => name === 'manifest.json')).toHaveLength(1)
    expect(files).toHaveLength(publishes + 1)
  }, 120_000)
})
