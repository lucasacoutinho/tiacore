import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { planK6 } from '../../src/runners/k6/index.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tiacore-k6-policy-'))
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

describe('k6 lane policy', () => {
  test('an unknown profile is rejected even next to an ambiguous one', async () => {
    const root = await project({
      'k6/profiles/smoke.js': '',
      'k6/profiles/smoke.ts': '',
      'k6/profiles/load.js': '',
    })
    const base = {
      changes: [],
      currentEnvironmentFingerprint: 'env',
      graph: null,
      profiles: 'k6/profiles',
      project: 'p',
      root,
    }
    await expect(
      planK6({ ...base, allowedProfiles: ['smoke', 'nope'] }),
    ).rejects.toThrow('k6 policy names an unknown or duplicate profile')
    await expect(
      planK6({ ...base, allowedProfiles: ['load', 'smoke', 'nope'] }),
    ).rejects.toThrow('k6 policy names an unknown or duplicate profile')
    expect(
      (await planK6({ ...base, allowedProfiles: ['load', 'load'] })).selected,
    ).toEqual(['k6:p:k6/profiles/load.js'])
  })
})
