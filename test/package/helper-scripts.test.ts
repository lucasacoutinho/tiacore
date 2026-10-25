import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { NODE_HELPER_SCRIPTS } from '../../src/runners/node/assets.ts'

// 1.x's CJS build lost the scripts its runners spawn (NODE-EXEC-06). Every
// helper must be a real ESM file in dist, built as its own entry point.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dist = join(root, 'dist/entries')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  )
}

describe('runner helper scripts', () => {
  test('every helper the Node runner can spawn is declared', () => {
    const referenced = new Set<string>()
    for (const file of sourceFiles(join(root, 'src/runners'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(
        /nodeHelperPath\(\s*'([^']+)'/gu,
      )) {
        referenced.add(match[1] ?? '')
      }
    }
    expect([...referenced].sort()).not.toEqual([])
    for (const name of referenced) {
      expect(NODE_HELPER_SCRIPTS as readonly string[]).toContain(name)
    }
  })

  test.each([...NODE_HELPER_SCRIPTS])(
    '%s exists in dist as an ES module',
    (name) => {
      const path = join(dist, name)
      expect(existsSync(path), `${path} is missing; run npm run build`).toBe(
        true,
      )
      expect(readFileSync(path, 'utf8')).not.toMatch(/\brequire\(["']\.\//u)
    },
  )

  test('the build lists every helper as an entry point and ships no CJS', () => {
    const meta: { outputs: Record<string, { entryPoint?: string }> } =
      JSON.parse(readFileSync(join(root, '.build/meta.json'), 'utf8'))
    const entries = new Set(
      Object.values(meta.outputs).flatMap((output) =>
        output.entryPoint === undefined ? [] : [output.entryPoint],
      ),
    )
    for (const name of NODE_HELPER_SCRIPTS) {
      expect(entries).toContain(
        `src/runners/node/${name.replace(/\.js$/u, '.ts')}`,
      )
    }
    expect(readdirSync(dist).filter((file) => /\.c[jt]s$/u.test(file))).toEqual(
      [],
    )
  })
})
