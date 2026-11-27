import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

interface Metafile {
  outputs: Record<
    string,
    {
      entryPoint?: string
      imports: { kind: string; path: string }[]
      inputs: Record<string, unknown>
    }
  >
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const metafile: Metafile = JSON.parse(
  readFileSync(join(root, '.build/meta.json'), 'utf8'),
)
const manifest: {
  exports: Record<string, string | { types: string }>
} = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const specifierPattern = /(?:from\s+|import\()\s*['"]([^'"]+)['"]/gu

function declarationClosure(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>()
  const pending = [entry]
  while (pending.length > 0) {
    const file = pending.pop()
    if (file === undefined || seen.has(file)) continue
    const specifiers = [
      ...readFileSync(file, 'utf8').matchAll(specifierPattern),
    ].map((match) => match[1] ?? '')
    seen.set(file, specifiers)
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue
      const target = resolve(dirname(file), specifier).replace(
        /\.(?:js|ts)$/u,
        '.d.ts',
      )
      if (existsSync(target)) pending.push(target)
    }
  }
  return seen
}

function staticInputs(output: string): Set<string> {
  const inputs = new Set<string>()
  const pending = [output]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || visited.has(current)) continue
    visited.add(current)
    const meta = metafile.outputs[current]
    if (meta === undefined) continue
    for (const input of Object.keys(meta.inputs)) inputs.add(input)
    for (const imported of meta.imports) {
      if (imported.kind === 'import-statement') pending.push(imported.path)
    }
  }
  return inputs
}

/** The packages an output imports statically, through its chunks. */
function staticExternals(output: string): Set<string> {
  const externals = new Set<string>()
  const pending = [output]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || visited.has(current)) continue
    visited.add(current)
    const meta = metafile.outputs[current]
    if (meta === undefined) continue
    for (const imported of meta.imports) {
      if (imported.kind !== 'import-statement') continue
      if (metafile.outputs[imported.path] === undefined) {
        externals.add(imported.path)
      } else {
        pending.push(imported.path)
      }
    }
  }
  return externals
}

describe('built package', () => {
  test('public declarations never reference Effect', () => {
    for (const target of Object.values(manifest.exports)) {
      if (typeof target === 'string') continue
      for (const [file, specifiers] of declarationClosure(
        join(root, target.types),
      )) {
        const effectImports = specifiers.filter(
          (specifier) =>
            specifier === 'effect' ||
            specifier.startsWith('effect/') ||
            specifier.startsWith('@effect/'),
        )
        expect({ effectImports, file }).toEqual({ effectImports: [], file })
      }
    }
  })

  test('the Vitest worker setup loads no Effect module', () => {
    const effectInputs = [
      ...staticInputs('dist/entries/vitest-setup.js'),
    ].filter((input) => input.includes('node_modules/effect/'))
    expect(effectInputs).toEqual([])
    expect(staticInputs('dist/entries/vitest-setup.js').size).toBeGreaterThan(0)
  })

  // vitest is an optional peer: only the worker setup, which Vitest itself
  // loads, may import it before a hook runs.
  test('no entry but the Vitest worker setup imports vitest when it loads', () => {
    const entries = Object.entries(metafile.outputs)
      .filter(([, meta]) => meta.entryPoint !== undefined)
      .map(([output]) => output)
      .filter((output) => !output.endsWith('vitest-setup.js'))
    expect(entries).toContain('dist/entries/vitest.js')
    for (const entry of entries) {
      const vitestImports = [...staticExternals(entry)].filter(
        (specifier) =>
          specifier === 'vitest' || specifier.startsWith('vitest/'),
      )
      expect({ entry, vitestImports }).toEqual({ entry, vitestImports: [] })
    }
  })

  test('the CLI version path loads no Effect module', () => {
    const effectInputs = [...staticInputs('dist/entries/cli.js')].filter(
      (input) => input.includes('node_modules/effect/'),
    )
    expect(effectInputs).toEqual([])
  })
})
