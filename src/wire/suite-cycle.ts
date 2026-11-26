type Suite = { readonly dependsOn?: readonly string[] }

/** Returns the first cycle entry in depth-first order, without using the call stack. */
export function suiteCycle(
  suites: ReadonlyMap<string, Suite>,
): string | undefined {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: Array<{ id: string; next: number }> = []
  for (const id of suites.keys()) {
    if (visited.has(id)) continue
    visiting.add(id)
    stack.push({ id, next: 0 })
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const dependencies = suites.get(frame.id)?.dependsOn
      const dependency = dependencies?.[frame.next++]
      if (dependency === undefined) {
        visiting.delete(frame.id)
        visited.add(frame.id)
        stack.pop()
      } else if (visiting.has(dependency)) {
        return dependency
      } else if (!visited.has(dependency)) {
        visiting.add(dependency)
        stack.push({ id: dependency, next: 0 })
      }
    }
  }
  return undefined
}
