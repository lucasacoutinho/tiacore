import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { describe, expect, test } from 'vitest'

import legacyExports from './legacy-exports.json' with { type: 'json' }
import pendingExports from './pending-exports.json' with { type: 'json' }

interface Manifest {
  bin: Record<string, string>
  exports: Record<string, string | { default: string; types: string }>
}

const root = new URL('../../', import.meta.url)
const manifest: Manifest = JSON.parse(
  readFileSync(new URL('package.json', root), 'utf8'),
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
      [
        ...Object.keys(legacyExports).filter((key) => key !== 'bin'),
        './package.json',
      ].toSorted(),
    )
  })

  test('lists exactly the 1.x runtime exports that 2.0 does not provide yet', async () => {
    const missing: string[] = []
    for (const [subpath, names] of Object.entries(legacyExports)) {
      const current = new Set(await exportedNames(subpath))
      for (const name of names) {
        if (!current.has(name)) missing.push(`${subpath} ${name}`)
      }
    }
    expect(missing.toSorted()).toEqual(pendingExports)
  })
})
