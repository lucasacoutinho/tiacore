import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { describe, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dist = join(root, 'dist')

function traceMap(script: string): TraceMap {
  const map = `${script}.map`
  return new TraceMap(readFileSync(map, 'utf8'), pathToFileURL(map).href)
}

/** The 1-based line and 0-based column of the first `needle` in `text`. */
function positionOf(
  text: string,
  needle: string,
): { column: number; line: number } {
  const lines = text.slice(0, text.indexOf(needle)).split('\n')
  return { column: lines.at(-1)?.length ?? 0, line: lines.length }
}

describe('built source maps', () => {
  test('the CLI bin starts with a hashbang and its map still points at the source', () => {
    const cli = join(dist, 'entries/cli.js')
    const source = join(root, 'src/entries/cli.ts')
    const code = readFileSync(cli, 'utf8')
    expect(code.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(statSync(cli).mode & 0o111).toBe(0o111)

    const original = originalPositionFor(
      traceMap(cli),
      positionOf(code, '"--version"'),
    )
    expect(original.source).toBe(pathToFileURL(source).href)
    const line =
      readFileSync(source, 'utf8').split('\n')[(original.line ?? 0) - 1] ?? ''
    expect(line.slice(original.column ?? 0)).toMatch(/^'--version'/u)
  })
})
