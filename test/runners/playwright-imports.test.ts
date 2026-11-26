import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

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

  describe("resolution follows Playwright's TypeScript loader", () => {
    test('a directory import resolves to its index file', async () => {
      const root = project({
        'lib/index.ts': '',
        'spec.ts': "import './lib'\n",
      })
      await expect(closure(root, 'spec.ts')).resolves.toEqual([
        'lib/index.ts',
        'spec.ts',
      ])
    })

    test('a file with the same name wins over the directory', async () => {
      const root = project({
        'lib.ts': '',
        'lib/index.ts': '',
        'spec.ts': "import './lib'\n",
      })
      await expect(closure(root, 'spec.ts')).resolves.toEqual([
        'lib.ts',
        'spec.ts',
      ])
    })

    test('a directory with a package.json resolves its main file, else its index', async () => {
      const root = project({
        'bare/index.js': '',
        'bare/package.json': '{}',
        'pkg/index.ts': '',
        'pkg/package.json': JSON.stringify({ main: './src/entry' }),
        'pkg/src/entry.ts': '',
        'spec.ts': "import './pkg'\nimport './bare'\n",
      })
      await expect(closure(root, 'spec.ts')).resolves.toEqual([
        'bare/index.js',
        'pkg/src/entry.ts',
        'spec.ts',
      ])
    })

    test('a dotted name gets each extension when no file has exactly that name', async () => {
      const root = project({
        'auth.helper.ts': '',
        'spec.ts': "import './auth.helper'\n",
      })
      await expect(closure(root, 'spec.ts')).resolves.toEqual([
        'auth.helper.ts',
        'spec.ts',
      ])

      const literal = project({
        'a.service': '',
        'a.service.ts': '',
        'spec.ts': "import './a.service'\n",
      })
      await expect(closure(literal, 'spec.ts')).resolves.toEqual([
        'a.service',
        'spec.ts',
      ])
    })

    test('a .js, .jsx, .mjs or .cjs specifier names its TypeScript source', async () => {
      const root = project({
        'a.ts': '',
        'b.tsx': '',
        'c.mts': '',
        'd.cts': '',
        'e.tsx': '',
        'spec.ts': [
          "import './a.js'",
          "import './b.js'",
          "import './c.mjs'",
          "import './d.cjs'",
          "import './e.jsx'",
        ].join('\n'),
      })
      await expect(closure(root, 'spec.ts')).resolves.toEqual([
        'a.ts',
        'b.tsx',
        'c.mts',
        'd.cts',
        'e.tsx',
        'spec.ts',
      ])
    })

    test('a .js file that exists wins over its TypeScript namesake', async () => {
      const root = project({
        'spec.ts': "import './x.js'\n",
        'x.js': '',
        'x.ts': '',
      })
      await expect(closure(root, 'spec.ts')).resolves.toEqual([
        'spec.ts',
        'x.js',
      ])
    })

    test("a bare name tries Playwright's extension order, then index files", async () => {
      const root = project({
        'both.js': '',
        'both.ts': '',
        'dir/index.js': '',
        'spec.ts': "import './both'\nimport './dir/index'\n",
      })
      await expect(closure(root, 'spec.ts')).resolves.toEqual([
        'both.js',
        'dir/index.js',
        'spec.ts',
      ])
    })

    test('agrees with the resolver of the installed Playwright', async () => {
      const { resolveImportSpecifierAfterMapping } = createRequire(
        import.meta.url,
      )('playwright/lib/util') as {
        resolveImportSpecifierAfterMapping(
          resolved: string,
          afterPathMapping: boolean,
        ): string | undefined
      }
      const cases: Array<[files: Record<string, string>, specifier: string]> = [
        [{ 'lib/index.ts': '' }, './lib'],
        [{ 'lib.ts': '', 'lib/index.ts': '' }, './lib'],
        [{ 'sub/index.mts': '' }, './sub/'],
        [{ 'auth.helper.ts': '' }, './auth.helper'],
        [{ 'a.service': '', 'a.service.ts': '' }, './a.service'],
        [{ 'a.ts': '' }, './a.js'],
        [{ 'b.jsx': '', 'b.ts': '' }, './b.js'],
        [{ 'c.mts': '' }, './c.mjs'],
        [{ 'd.cts': '' }, './d.cjs'],
        [{ 'e.tsx': '' }, './e.jsx'],
        [{ 'x.js': '', 'x.ts': '' }, './x.js'],
        [{ 'q.js/index.ts': '' }, './q.js'],
        [{ 'both.js': '', 'both.ts': '' }, './both'],
        [{ 'one.ts': '' }, './one.ts'],
        [{ 'other.ts': '' }, './missing'],
      ]
      for (const [files, specifier] of cases) {
        const root = project({ ...files, 'spec.ts': `import '${specifier}'\n` })
        const expected = resolveImportSpecifierAfterMapping(
          resolve(root, specifier),
          false,
        )
        const resolved = (await closure(root, 'spec.ts')).filter(
          (file) => file !== 'spec.ts',
        )
        expect({ resolved, specifier }).toEqual({
          resolved: expected === undefined ? [] : [relative(root, expected)],
          specifier,
        })
      }
    })

    test('a JSON file is tried last, as Node finds it', async () => {
      const root = project({
        'config.json': '{}',
        'config.ts': '',
        'data.json': '{}',
        'spec.ts': "import './config'\nconst data = require('./data')\n",
      })
      await expect(closure(root, 'spec.ts')).resolves.toEqual([
        'config.ts',
        'data.json',
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

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unreadable file is still recorded',
    async () => {
      const root = project({
        'behind.ts': '',
        'hidden.ts': "import './behind'\n",
        'spec.ts': "import './hidden'\n",
      })
      chmodSync(join(root, 'hidden.ts'), 0o000)
      // The import resolves, cannot be read, and contributes nothing more.
      await expect(closure(root, 'spec.ts')).resolves.toEqual([
        'hidden.ts',
        'spec.ts',
      ])
    },
  )

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
