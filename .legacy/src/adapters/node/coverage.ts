import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

import { isInside, slash } from '../../shared/paths.js'
import { canonicalNodePath } from './discovery.js'

interface V8CoverageFile {
  result?: {
    functions?: {
      ranges?: { count?: number }[]
    }[]
    url?: string
  }[]
}

function scriptExecuted(
  functions: NonNullable<V8CoverageFile['result']>[number]['functions'],
): boolean {
  return (
    functions?.some((fn) =>
      fn.ranges?.some((range) => (range.count ?? 0) > 0),
    ) ?? false
  )
}

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
      const coverage = JSON.parse(
        readFileSync(`${directory}/${name}`, 'utf8'),
      ) as V8CoverageFile
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
        if (file !== '' && !file.startsWith('node_modules/')) {
          files.add(file)
        }
      }
    } catch {
      // A child can exit while another coverage file is still being flushed.
    }
  }

  return [...files].sort()
}
