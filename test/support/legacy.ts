import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const legacyDist = fileURLToPath(
  new URL('../../.legacy/dist/', import.meta.url),
)

/** Imports a module from the built 1.x package, the differential oracle. */
export async function legacy<T>(module: string): Promise<T> {
  const file = `${legacyDist}${module}`
  if (!existsSync(file)) {
    throw new Error(
      `the 1.x oracle is not built (${file}); run npm run build:legacy`,
    )
  }
  return (await import(file)) as T
}
