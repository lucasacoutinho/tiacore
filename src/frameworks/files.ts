import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import picomatch from 'picomatch'

import { slash } from '../shared/paths.js'

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.tia',
  'build',
  'coverage',
  'dist',
  'node_modules',
])

export function matchingFiles(root: string, patterns: string[]): string[] {
  const matches = picomatch(patterns, { dot: true })
  const files: string[] = []

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue
      }

      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
      } else if (entry.isFile()) {
        const file = slash(relative(root, absolute))
        if (matches(file)) {
          files.push(file)
        }
      }
    }
  }

  walk(root)
  return files.sort()
}
