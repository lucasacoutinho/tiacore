import * as Match from 'effect/Match'

import { byCodeUnit } from '../core/canonical.ts'

type Triple = readonly [number, number, number]

interface Version {
  readonly core: Triple
  /** The dot-separated prerelease identifiers; empty for a release. */
  readonly prerelease: readonly string[]
}

const VERSION_PATTERN =
  /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([^+]*))?(?:\+.*)?$/u

const NUMERIC = /^\d+$/u

function parseVersion(text: string): Version | null {
  const match = VERSION_PATTERN.exec(text)
  if (match === null) return null
  return {
    core: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareCore(left: Triple, right: Triple): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Numeric identifiers compare as numbers and sort below alphanumeric ones. */
function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = NUMERIC.test(left)
  const rightNumeric = NUMERIC.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return byCodeUnit(left, right)
}

/** SemVer 2.0.0 precedence: build metadata is ignored and a prerelease sorts below its release. */
function compare(left: Version, right: Version): number {
  const core = compareCore(left.core, right.core)
  if (core !== 0) return core
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length
  }
  const shared = Math.min(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < shared; index += 1) {
    const difference = compareIdentifiers(
      left.prerelease[index] ?? '',
      right.prerelease[index] ?? '',
    )
    if (difference !== 0) return difference
  }
  return left.prerelease.length - right.prerelease.length
}

/**
 * Whether `version` is below the exclusive upper bound `bound`. A bound
 * without a prerelease also shuts out its own prereleases: `<6.0.0` and
 * `^5.0.0` mean "before 6", so 6.0.0-beta.1 is outside them.
 */
function below(version: Version, bound: Version): boolean {
  if (
    bound.prerelease.length === 0 &&
    compareCore(version.core, bound.core) === 0
  ) {
    return false
  }
  return compare(version, bound) < 0
}

/** The upper bound of a `^` or `~` comparator. */
function upperBound(operator: '^' | '~', base: Version): Version {
  const [major, minor, patch] = base.core
  const core: Triple =
    operator === '~'
      ? [major, minor + 1, 0]
      : major > 0
        ? [major + 1, 0, 0]
        : minor > 0
          ? [0, minor + 1, 0]
          : [0, 0, patch + 1]
  return { core, prerelease: [] }
}

function satisfiesComparator(
  version: Version,
  comparator: string,
): boolean | null {
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/u.exec(comparator)
  const operator = match?.[1] ?? '='
  const target = parseVersion(match?.[2] ?? '')
  if (target === null) return null
  const order = compare(version, target)
  return Match.value(operator).pipe(
    Match.when('>=', () => order >= 0),
    Match.when('>', () => order > 0),
    Match.when('<=', () => order <= 0),
    Match.when('<', () => below(version, target)),
    Match.when(
      (value) => value === '^' || value === '~',
      (value) => order >= 0 && below(version, upperBound(value, target)),
    ),
    Match.orElse(() => order === 0),
  )
}

/**
 * Whether `version` satisfies `range`. Supports the forms tiacore's own
 * package.json uses: `||` alternatives and space-separated comparators with
 * `>=`, `>`, `<=`, `<`, `=`, `^` and `~`. Versions order by SemVer
 * precedence, so 4.1.0-beta.1 is below 4.1.0. Returns null for anything
 * else, so the caller can say "unknown" instead of guessing.
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
