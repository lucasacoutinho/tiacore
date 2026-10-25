const TRUTHY = new Set(['1', 'on', 'true', 'yes'])

/**
 * Reads a boolean environment flag. `1`, `true`, `yes` and `on` (in any case)
 * mean true; anything else, including an unset variable, means false. Every
 * tiacore flag, `TIA_FRESH` among them, is read this way.
 */
export function envFlag(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  return TRUTHY.has(env[name]?.trim().toLowerCase() ?? '')
}

/** Whether `TIA_FRESH` asks for a fresh graph. */
export function freshRequested(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return envFlag(env, 'TIA_FRESH')
}
