import * as fs from 'node:fs'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import { tia } from '../../../src/runners/vitest/plugin.ts'

// Two Vitest processes starting on one project share .tia/runtime. Each lists
// the stale setup modules of earlier versions and removes them, so one can
// find a listed file already gone. The listing below names a file that is
// not there, as the slower process sees it.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: vi.fn<typeof actual.readdirSync>(actual.readdirSync),
  }
})

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

interface ConfigHook {
  config?: (config: { root: string; test?: Record<string, unknown> }) => void
}

test('tolerates a stale setup module another process already removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-setup-proxy-'))
  roots.push(root)
  const runtime = join(root, '.tia', 'runtime')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, 'setup-1.2.1.mjs'), 'import "old"\n')
  vi.mocked(fs.readdirSync).mockImplementationOnce(((
    directory: fs.PathLike,
  ) => [
    ...readdirSync(directory, 'utf8'),
    'setup-0.0.1.mjs',
  ]) as typeof fs.readdirSync)

  const plugin = tia({ enabled: true }) as unknown as ConfigHook
  const config: { root: string; test?: Record<string, unknown> } = { root }
  expect(() => plugin.config?.(config)).not.toThrow()
  const names = readdirSync(runtime)
  expect(names).toHaveLength(1)
  expect(names[0]).toMatch(/^setup-.*\.mjs$/u)
  expect(names[0]).not.toBe('setup-1.2.1.mjs')
})
