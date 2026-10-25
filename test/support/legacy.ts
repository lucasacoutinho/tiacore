import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The published 1.x package (devDependency `tiacore-v1`), the oracle of the
 * differential tests.
 */
export const legacyDist = fileURLToPath(
  new URL('../../node_modules/tiacore-v1/dist/', import.meta.url),
)

/** Imports a module from the 1.x package. */
export async function legacy<T>(module: string): Promise<T> {
  const file = `${legacyDist}${module}`
  if (!existsSync(file)) {
    throw new Error(`the 1.x oracle is missing (${file}); run npm ci`)
  }
  return (await import(file)) as T
}
