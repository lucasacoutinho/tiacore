/** True for a non-null, non-array object, narrowed so its fields can be checked. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
