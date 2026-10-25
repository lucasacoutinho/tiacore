import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import { TiaEvidence } from '../../src/evidence/index.ts'

// Ported from test/integration/evidence/cross-process.integration.test.ts. The
// 1.x test linked the package into a fixture project; this one runs the service
// against the built `./evidence` entry, which is what a consumer imports.

const entry = pathToFileURL(
  fileURLToPath(new URL('../../dist/entries/evidence.js', import.meta.url)),
).href
const service = `
import { tia } from ${JSON.stringify(entry)}

const [correlationId, file, producer] = process.argv.slice(2)
const evidence = tia({
  directory: '.tia/evidence',
  producer,
  root: process.cwd(),
})
const observed = evidence.fromHeaders({
  'X-Tiacore-Correlation-Id': correlationId,
})

if (observed !== null) {
  await evidence.run(observed, () => evidence.record([file]))
}
`

const roots: string[] = []

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-evidence-service-'))
  roots.push(root)
  writeFileSync(join(root, 'record.mjs'), service)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

function record(
  root: string,
  correlationId: string,
  file: string,
  producer: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['record.mjs', correlationId, file, producer],
      { cwd: root, stdio: 'inherit' },
    )
    child.once('error', reject)
    child.once('exit', (status) => {
      if (status === 0) resolve()
      else reject(new Error(`evidence service exited with ${status}`))
    })
  })
}

describe('correlated cross-process evidence', () => {
  test('merges evidence emitted concurrently by independent services', async () => {
    const root = project()
    const evidence = new TiaEvidence({
      directory: join(root, '.tia/evidence'),
      root,
    })
    const correlationId = evidence.correlationId('browser-test-42')

    await Promise.all([
      record(root, correlationId, 'apps/api/src/member.ts', 'api'),
      record(root, correlationId, 'packages/database/src/member.ts', 'worker'),
    ])

    await expect(evidence.collect(correlationId)).resolves.toEqual([
      'apps/api/src/member.ts',
      'packages/database/src/member.ts',
    ])
    await expect(
      evidence.collect(correlationId, { remove: true }),
    ).resolves.toHaveLength(2)
    await expect(evidence.collect(correlationId)).resolves.toEqual([])
  })

  test('ignores an invalid incoming correlation header', async () => {
    const root = project()
    await record(root, '../unsafe', 'src/unsafe.ts', 'api')

    const evidence = new TiaEvidence({
      directory: join(root, '.tia/evidence'),
      root,
    })
    await expect(evidence.collect('safe-id')).resolves.toEqual([])
  })
})
