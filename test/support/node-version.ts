/** Whether the running Node is at least `minimum` (`major.minor.patch`). */
export function nodeAtLeast(
  minimum: string,
  current: string = process.versions.node,
): boolean {
  const have = current.split('.').map(Number)
  const need = minimum.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

/**
 * Flags a child Node needs to run a TypeScript file directly: type stripping
 * is on by default from 22.18 and behind a flag from 22.6.
 */
export const TYPESCRIPT_FLAGS: readonly string[] = nodeAtLeast('22.18.0')
  ? []
  : ['--experimental-strip-types']

/** `module.registerHooks`, which node:test case discovery needs, is 22.15+. */
export const NODE_DISCOVERY_HOOKS = nodeAtLeast('22.15.0')
