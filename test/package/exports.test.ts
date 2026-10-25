import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { describe, expect, test } from 'vitest'

interface Manifest {
  bin: Record<string, string>
  exports: Record<string, string | { default: string; types: string }>
}

const root = new URL('../../', import.meta.url)
const manifest: Manifest = JSON.parse(
  readFileSync(new URL('package.json', root), 'utf8'),
)
// The published 1.2.1, installed as the devDependency `tiacore-v1`.
const v1: Pick<Manifest, 'exports'> = JSON.parse(
  readFileSync(new URL('node_modules/tiacore-v1/package.json', root), 'utf8'),
)
const v1Subpaths = Object.keys(v1.exports).filter(
  (subpath) => subpath !== './package.json',
)

function entryFile(subpath: string): string {
  if (subpath === 'bin') return manifest.bin['tiacore'] ?? ''
  const target = manifest.exports[subpath]
  if (target === undefined || typeof target === 'string') return ''
  return target.default
}

async function exportedNames(subpath: string): Promise<string[]> {
  const module: object = await import(
    pathToFileURL(new URL(entryFile(subpath), root).pathname).href
  )
  return Object.keys(module)
}

describe('public exports', () => {
  test('keeps every 1.x subpath', () => {
    expect(Object.keys(manifest.exports).toSorted()).toEqual(
      [...v1Subpaths, './package.json'].toSorted(),
    )
  })

  test('keeps every 1.x runtime export', async () => {
    const missing: string[] = []
    for (const subpath of v1Subpaths) {
      const specifier =
        subpath === '.' ? 'tiacore-v1' : `tiacore-v1/${subpath.slice(2)}`
      const previous: object = await import(specifier)
      const current = new Set(await exportedNames(subpath))
      for (const name of Object.keys(previous)) {
        if (!current.has(name)) missing.push(`${subpath} ${name}`)
      }
    }
    expect(missing).toEqual([])
  })
})
