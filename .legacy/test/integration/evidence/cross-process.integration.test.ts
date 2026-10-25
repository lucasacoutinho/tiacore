import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { TiaEvidence } from '../../../src/integrations/evidence/index.js'
import {
  cleanupProjects,
  createFixtureProject,
} from '../../helpers/integration-project.js'

afterEach(() => {
  cleanupProjects()
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
    const root = createFixtureProject('evidence-service')
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
    const root = createFixtureProject('evidence-service')
    await record(root, '../unsafe', 'src/unsafe.ts', 'api')

    const evidence = new TiaEvidence({
      directory: join(root, '.tia/evidence'),
      root,
    })
    await expect(evidence.collect('safe-id')).resolves.toEqual([])
  })
})
