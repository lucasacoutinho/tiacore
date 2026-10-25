import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const specifierPattern = /(?:from\s+|import\()\s*['"]([^'"]+)['"]/gu

function sourceFiles(directory: string): string[] {
  let entries
  try {
    entries = readdirSync(join(root, directory), {
      recursive: true,
      withFileTypes: true,
    })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
}

function forbiddenImports(
  directory: string,
  forbidden: (specifier: string) => boolean,
): string[] {
  return sourceFiles(directory).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(specifierPattern)]
      .map((match) => match[1] ?? '')
      .filter(forbidden)
      .map((specifier) => `${relative(root, file)} -> ${specifier}`),
  )
}

const isEffect = (specifier: string) =>
  specifier === 'effect' ||
  specifier.startsWith('effect/') ||
  specifier.startsWith('@effect/')
const isNode = (specifier: string) => specifier.startsWith('node:')

describe('module purity', () => {
  test.each(['src/core', 'src/probe'])(
    '%s imports neither Effect nor Node built-ins',
    (directory) => {
      expect(
        forbiddenImports(
          directory,
          (specifier) => isEffect(specifier) || isNode(specifier),
        ),
      ).toEqual([])
    },
  )

  test('src/evidence imports no Effect', () => {
    expect(forbiddenImports('src/evidence', isEffect)).toEqual([])
  })

  // effect-conventions.md: classification over tagged unions uses Match
  // outside the Effect-free core and probe, and Option/Exit use their guards.
  test('Effect layers classify with Match, not switch or raw Option/Exit tags', () => {
    const effectFree = ['src/core/', 'src/probe/']
    const offenders = sourceFiles('src').flatMap((file) => {
      const path = relative(root, file).replaceAll('\\', '/')
      const text = readFileSync(file, 'utf8')
      const hits: string[] = []
      if (
        !effectFree.some((prefix) => path.startsWith(prefix)) &&
        /\bswitch\s*\(/u.test(text)
      ) {
        hits.push(`${path}: switch`)
      }
      if (/\._tag\s*===\s*'(?:None|Some|Failure|Success)'/u.test(text)) {
        hits.push(`${path}: raw Option/Exit tag`)
      }
      return hits
    })
    expect(offenders).toEqual([])
  })
})
