import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The helper scripts the Node runner spawns; each is an esbuild entry point. */
export const NODE_HELPER_SCRIPTS = [
  'discovery-register.js',
  'discovery-shim.js',
  'execution-child.js',
] as const

export type NodeHelperScript = (typeof NODE_HELPER_SCRIPTS)[number]

// The helpers sit next to the entry files in dist. The runner's code lives in
// an entry file or in a chunk below it, and runs from `src` under test, so
// look beside this module, one level up, and in the repository's own build.
const SEARCH = ['./', '../', '../../../dist/entries/'] as const

/** Absolute path of a helper script, or null when no build provides it. */
export function nodeHelperPath(name: NodeHelperScript): string | null {
  for (const directory of SEARCH) {
    const candidate = fileURLToPath(
      new URL(`${directory}${name}`, import.meta.url),
    )
    if (existsSync(candidate)) return candidate
  }
  return null
}
