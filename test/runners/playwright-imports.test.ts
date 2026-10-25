import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  importedFilesFingerprint,
  importedProjectFiles,
  type ImportMemo,
} from '../../src/runners/playwright/imports.ts'
import { legacy } from '../support/legacy.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-playwright-imports-'))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

const closure = (root: string, entry: string) =>
  importedProjectFiles(join(root, entry), root)

describe('import discovery', () => {
  test('follows every relative form the lexer and the require scan see', async () => {
    const root = project({
      'a.ts': '',
      'b.ts': '',
      'c.ts': '',
      'd.ts': '',
      'e.ts': '',
      'f.ts': '',
      'g.ts': '',
      'h.cjs': '',
      'spec.ts': [
        "import './a'",
        "import { b } from './b'",
        "export * from './c'",
        "export { d } from './d'",
        "const e = await import('./e')",
        "import type { F } from './f'",
        "import g = require('./g')",
        "const h = require('./h.cjs')",
      ].join('\n'),
    })
    await expect(closure(root, 'spec.ts')).resolves.toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
      'd.ts',
      'e.ts',
      'f.ts',
      'g.ts',
      'h.cjs',
      'spec.ts',
    ])
  })

  test('walks the closure, survives cycles and skips non-relative specifiers', async () => {
    const root = project({
      'lib/one.ts': "import './two'\nimport 'left-pad'\nimport '@/alias'\n",
      'lib/two.ts': "import './one'\nimport 'node:fs'\n",
      'spec.ts': "import './lib/one'\n",
    })
    await expect(closure(root, 'spec.ts')).resolves.toEqual([
      'lib/one.ts',
      'lib/two.ts',
      'spec.ts',
    ])
  })

  test('ignores specifiers inside comments and strings, which the 1.x scanner followed', async () => {
    const root = project({
      'commented.ts': '',
      'quoted.ts': '',
      'real.ts': '',
      'spec.ts': [
        "import './real'",
        "// import './commented'",
        'const text = "import \'./quoted\'"',
      ].join('\n'),
    })
    await expect(closure(root, 'spec.ts')).resolves.toEqual([
      'real.ts',
      'spec.ts',
    ])
  })

  test('falls back to the 1.x scanner for source the lexer rejects', async () => {
    const root = project({
      'broken.ts': '',
      'spec.ts': "import './broken'\nconst oops = `unterminated ${\n",
    })
    await expect(closure(root, 'spec.ts')).resolves.toEqual([
      'broken.ts',
      'spec.ts',
    ])
  })

  describe('1.x resolution quirks kept on purpose', () => {
    test('a directory import is recorded as the directory, not its index file', async () => {
      const root = project({
        'lib/index.ts': '',
        'spec.ts': "import './lib'\n",
      })
      await expect(closure(root, 'spec.ts')).resolves.toEqual([
        'lib',
        'spec.ts',
      ])
    })

    test('a dotted name resolves only to a file of exactly that name', async () => {
      const root = project({
        'a.service.ts': '',
        'spec.ts': "import './a.service'\n",
      })
      await expect(closure(root, 'spec.ts')).resolves.toEqual(['spec.ts'])

      const literal = project({
        'a.service': '',
        'spec.ts': "import './a.service'\n",
      })
      await expect(closure(literal, 'spec.ts')).resolves.toEqual([
        'a.service',
        'spec.ts',
      ])
    })

    test('./x.js does not map to x.ts', async () => {
      const root = project({ 'spec.ts': "import './x.js'\n", 'x.ts': '' })
      await expect(closure(root, 'spec.ts')).resolves.toEqual(['spec.ts'])
    })

    test('a bare name tries each extension in order, then index files', async () => {
      const root = project({
        'both.js': '',
        'both.ts': '',
        'dir/index.js': '',
        'spec.ts': "import './both'\nimport './dir/index'\n",
      })
      await expect(closure(root, 'spec.ts')).resolves.toEqual([
        'both.ts',
        'dir/index.js',
        'spec.ts',
      ])
    })
  })

  test('files outside the root are neither recorded nor followed', async () => {
    const outer = project({
      'outside.ts': "import './inner/deep'\n",
      'inner/deep.ts': '',
      'inner/spec.ts': "import '../outside'\n",
    })
    const root = join(outer, 'inner')
    await expect(closure(root, 'spec.ts')).resolves.toEqual(['spec.ts'])
  })

  test('an unreadable file is still recorded', async () => {
    const root = project({
      'dir/index.ts': '',
      'spec.ts': "import './dir'\n",
    })
    // The directory resolves, cannot be read as text, and contributes nothing more.
    await expect(closure(root, 'spec.ts')).resolves.toContain('dir')
  })

  test('a shared memo gives each entry its own closure and reads a helper once', async () => {
    const root = project({
      'one.spec.ts': "import './shared'\n",
      'shared.ts': "import './leaf'\n",
      'leaf.ts': '',
      'two.spec.ts': "import './shared'\n",
    })
    const memo: ImportMemo = new Map()
    await expect(
      importedProjectFiles(join(root, 'one.spec.ts'), root, memo),
    ).resolves.toEqual(['leaf.ts', 'one.spec.ts', 'shared.ts'])
    // The helper is now remembered, so a later edit does not show through.
    writeFileSync(join(root, 'shared.ts'), '')
    await expect(
      importedProjectFiles(join(root, 'two.spec.ts'), root, memo),
    ).resolves.toEqual(['leaf.ts', 'shared.ts', 'two.spec.ts'])
    await expect(
      importedProjectFiles(join(root, 'two.spec.ts'), root),
    ).resolves.toEqual(['shared.ts', 'two.spec.ts'])
  })

  test('matches 1.x on ordinary specs', async () => {
    const root = project({
      'helpers/page.ts': "import '../fixtures/data.json'\n",
      'fixtures/data.json': '{}',
      'e2e/login.spec.ts': [
        "import { test } from '@playwright/test'",
        "import { page } from '../helpers/page'",
        "import data from '../fixtures/data.json'",
        'test("x", async () => { await import("../helpers/page") })',
      ].join('\n'),
    })
    const old = await legacy<{
      importedProjectFiles(entry: string, root: string): string[]
    }>('adapters/playwright/imports.js')
    const entry = join(root, 'e2e/login.spec.ts')
    await expect(importedProjectFiles(entry, root)).resolves.toEqual(
      old.importedProjectFiles(entry, root),
    )
  })
})

describe('import closure fingerprint', () => {
  test('changes with any file in the closure and with a deletion', async () => {
    const root = project({
      'config.ts': "import './shared'\n",
      'shared.ts': 'export const a = 1\n',
    })
    const entry = join(root, 'config.ts')
    const first = await importedFilesFingerprint(entry, root)
    expect(await importedFilesFingerprint(entry, root)).toBe(first)

    writeFileSync(join(root, 'shared.ts'), 'export const a = 2\n')
    const edited = await importedFilesFingerprint(entry, root)
    expect(edited).not.toBe(first)

    rmSync(join(root, 'shared.ts'))
    const removed = await importedFilesFingerprint(entry, root)
    expect(removed).not.toBe(edited)
  })

  test('is unaffected by files the config does not import', async () => {
    const root = project({ 'config.ts': '', 'other.ts': '' })
    const entry = join(root, 'config.ts')
    const first = await importedFilesFingerprint(entry, root)
    writeFileSync(join(root, 'other.ts'), 'changed')
    expect(await importedFilesFingerprint(entry, root)).toBe(first)
  })
})
