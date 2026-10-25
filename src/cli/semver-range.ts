type Triple = readonly [number, number, number]

const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/u

function parseVersion(text: string): Triple | null {
  const match = VERSION_PATTERN.exec(text)
  if (match === null) return null
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function compare(left: Triple, right: Triple): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** The half-open bounds of a `^` or `~` comparator. */
function bounds(operator: '^' | '~', base: Triple): [Triple, Triple] {
  const [major, minor, patch] = base
  if (operator === '~') return [base, [major, minor + 1, 0]]
  if (major > 0) return [base, [major + 1, 0, 0]]
  if (minor > 0) return [base, [0, minor + 1, 0]]
  return [base, [0, 0, patch + 1]]
}

function satisfiesComparator(
  version: Triple,
  comparator: string,
): boolean | null {
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/u.exec(comparator)
  const operator = match?.[1] ?? '='
  const target = parseVersion(match?.[2] ?? '')
  if (target === null) return null
  switch (operator) {
    case '>=':
      return compare(version, target) >= 0
    case '>':
      return compare(version, target) > 0
    case '<=':
      return compare(version, target) <= 0
    case '<':
      return compare(version, target) < 0
    case '^':
    case '~': {
      const [low, high] = bounds(operator, target)
      return compare(version, low) >= 0 && compare(version, high) < 0
    }
    default:
      return compare(version, target) === 0
  }
}

/**
 * Whether `version` satisfies `range`. Supports the forms tiacore's own
 * package.json uses: `||` alternatives and space-separated comparators with
 * `>=`, `>`, `<=`, `<`, `=`, `^` and `~`. Returns null for anything else, so
 * the caller can say "unknown" instead of guessing.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const parsed = parseVersion(version)
  if (parsed === null) return null
  let unknown = false
  for (const alternative of range.split('||')) {
    const comparators = alternative.trim().split(/\s+/u)
    let all = true
    for (const comparator of comparators) {
      const result = satisfiesComparator(parsed, comparator)
      if (result === null) {
        unknown = true
        all = false
      } else if (!result) {
        all = false
      }
    }
    if (all) return true
  }
  return unknown ? null : false
}
