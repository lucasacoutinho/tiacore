import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import { byCodeUnit } from '../../core/canonical.ts'
import { isInside, slash } from '../../engine/host-path.ts'
import { canonicalNodePath } from './paths.ts'

interface V8Script {
  functions?: { ranges?: { count?: number }[] }[]
  url?: string
}

function scriptExecuted(functions: V8Script['functions']): boolean {
  return (
    functions?.some((fn) =>
      fn.ranges?.some((range) => (range.count ?? 0) > 0),
    ) ?? false
  )
}

/**
 * Project files that ran in a child, from the JSON files `NODE_V8_COVERAGE`
 * wrote into `directory`. Only a root-level `node_modules/` prefix is
 * filtered (a nested one is a dependency worth recording). A half-written file
 * is skipped: a child may still be flushing.
 */
export function readNodeV8CoverageFiles(
  directory: string,
  root: string,
): string[] {
  if (!existsSync(directory)) return []

  const canonicalRoot = canonicalNodePath(root)
  const files = new Set<string>()

  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue
    try {
      const coverage: { result?: V8Script[] } = JSON.parse(
        readFileSync(join(directory, name), 'utf8'),
      )
      for (const script of coverage.result ?? []) {
        const url = script.url ?? ''
        if (
          !scriptExecuted(script.functions) ||
          (!url.startsWith('file:') && !isAbsolute(url))
        ) {
          continue
        }
        const absoluteFile = canonicalNodePath(url)
        if (!isInside(canonicalRoot, absoluteFile)) continue
        const file = slash(relative(canonicalRoot, absoluteFile))
        if (file !== '' && !file.startsWith('node_modules/')) files.add(file)
      }
    } catch {
      // A child can exit while another coverage file is still being flushed.
    }
  }

  return [...files].sort(byCodeUnit)
}
