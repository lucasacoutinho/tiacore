export interface ParsedArguments {
  command: string
  flags: Set<string>
  options: Map<string, string[]>
}

export function parseArguments(
  arguments_: readonly string[],
): ParsedArguments {
  const primary = arguments_[0] ?? 'help'
  const nested = arguments_[1]
  const hasNestedCommand =
    (primary === 'maestro' || primary === 'k6' || primary === 'certify') &&
    nested !== undefined &&
    !nested.startsWith('--')
  const command = hasNestedCommand ? `${primary}:${nested}` : primary
  const flags = new Set<string>()
  const options = new Map<string, string[]>()
  for (
    let index = hasNestedCommand ? 2 : 1;
    index < arguments_.length;
    index += 1
  ) {
    const argument = arguments_[index]
    if (argument === undefined || !argument.startsWith('--')) {
      throw new Error(`unexpected argument: ${String(argument)}`)
    }
    const name = argument.slice(2)
    const next = arguments_[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.add(name)
      continue
    }
    const values = options.get(name) ?? []
    values.push(next)
    options.set(name, values)
    index += 1
  }
  return { command, flags, options }
}

export function option(
  parsed: ParsedArguments,
  name: string,
  required = false,
): string | undefined {
  const values = parsed.options.get(name)
  if ((values?.length ?? 0) > 1) {
    throw new Error(`--${name} may only be supplied once`)
  }
  const value = values?.[0]
  if (required && value === undefined) {
    throw new Error(`missing required option --${name}`)
  }
  return value
}

export function repeated(parsed: ParsedArguments, name: string): string[] {
  return parsed.options.get(name) ?? []
}
