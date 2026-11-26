import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import { TiaEvidence } from '../../src/evidence/index.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn<typeof actual.rename>(actual.rename),
    writeFile: vi.fn<typeof actual.writeFile>(actual.writeFile),
  }
})

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

test('a failed rename leaves no temporary event behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-evidence-rename-'))
  directories.push(root)
  const evidence = new TiaEvidence({ root })
  vi.mocked(rename).mockRejectedValueOnce(
    Object.assign(new Error('EPERM: operation not permitted'), {
      code: 'EPERM',
    }),
  )
  await expect(evidence.record(['src/a.ts'], 'renamed')).rejects.toThrow(
    'EPERM',
  )
  const [directory] = readdirSync(evidence.directory)
  expect(readdirSync(join(evidence.directory, directory ?? ''))).toEqual([])
  await expect(evidence.collectChecked('renamed')).resolves.toEqual({
    complete: true,
    files: [],
  })
})

test('recreates a directory a collection removed while recording', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-evidence-rename-'))
  directories.push(root)
  const evidence = new TiaEvidence({ root })
  vi.mocked(writeFile).mockRejectedValueOnce(
    Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    }),
  )
  await evidence.record(['src/a.ts'], 'raced')
  await expect(evidence.collect('raced')).resolves.toEqual(['src/a.ts'])
})
