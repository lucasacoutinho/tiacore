import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import { coveredSourceMapFiles } from '../../../src/adapters/playwright/source-maps.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

test('maps only executed generated ranges to their original files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-playwright-map-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src/b.ts'), 'export const b = 2\n')

  const map = Buffer.from(
    JSON.stringify({
      mappings: 'AAAA;ACAA',
      names: [],
      sources: ['src/a.ts', 'src/b.ts'],
      version: 3,
    }),
  ).toString('base64')
  const script =
    `a();\nb();\n//# sourceMappingURL=data:application/json;base64,${map}`

  await expect(
    coveredSourceMapFiles(
      'http://fixture.test/bundle.js',
      script,
      [
        {
          ranges: [
            {
              count: 1,
              endOffset: script.length,
              startOffset: 0,
            },
          ],
        },
        {
          ranges: [
            {
              count: 0,
              endOffset: 9,
              startOffset: 5,
            },
          ],
        },
      ],
      root,
    ),
  ).resolves.toEqual(['src/a.ts'])
})
