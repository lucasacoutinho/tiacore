import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let archerModule

try {
  archerModule = await import('@lucasacoutinho/archer/vitest')
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error

  const configured = process.env.ARCHER_VITEST_ENTRY?.trim()
  const candidates = [
    ...(configured === undefined || configured === '' ? [] : [configured]),
    path.resolve('..', 'archer', 'dist', 'vitest.js'),
  ]
  const entry = candidates.find((candidate) => existsSync(candidate))
  if (entry === undefined) {
    throw new Error(
      'Archer is unavailable. Install @lucasacoutinho/archer, set ARCHER_VITEST_ENTRY, or build the adjacent ../archer checkout.',
      { cause: error },
    )
  }
  archerModule = await import(pathToFileURL(entry).href)
}

export function loadArcherPlugin() {
  return archerModule
}
