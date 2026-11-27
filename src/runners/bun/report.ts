import { relative, resolve } from 'node:path'

import { XMLParser } from 'fast-xml-parser'

import { byCodeUnit } from '../../core/canonical.ts'
import { isRecord } from '../../core/record.ts'
import { isInside, slash } from '../../engine/host-path.ts'

export interface BunCase {
  /** The describe blocks around the case, outermost first; absent at the top level. */
  describes?: string[]
  duration?: number
  file: string
  fullName: string
  id: string
  line: number
  state: 'failed' | 'passed' | 'skipped'
}

/** The persisted bun:test id: `<file>:<line>:<name>` (Bun reports no column). */
export function bunTestId(file: string, line: number, name: string): string {
  return `${file}:${line}:${name}`
}

// Bun writes a control character in a name as a numeric reference (&#10;),
// which fast-xml-parser decodes with its HTML entities. Values stay untrimmed
// strings.
const parser = new XMLParser({
  attributeNamePrefix: '',
  htmlEntities: true,
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  preserveOrder: true,
  trimValues: false,
})

/** A testcase element and the describe blocks around it. */
interface ReportedCase {
  readonly attributes: Record<string, unknown>
  readonly children: Record<string, unknown>[]
  readonly describes: string[]
}

/** The elements of a node list in fast-xml-parser's ordered output. */
function elements(nodes: unknown): Record<string, unknown>[] {
  return Array.isArray(nodes) ? nodes.filter(isRecord) : []
}

function attributesOf(
  element: Record<string, unknown>,
): Record<string, unknown> {
  const attributes = element[':@']
  return isRecord(attributes) ? attributes : {}
}

function stringAttribute(
  attributes: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = attributes[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Collects the testcase elements of `nodes` in report order. Bun puts each
 * file in a testsuite and nests one testsuite per describe block in it, so a
 * suite inside a file's suite is a describe block.
 */
function collectCases(
  nodes: readonly Record<string, unknown>[],
  describes: readonly string[],
  inFile: boolean,
  cases: ReportedCase[],
): void {
  for (const node of nodes) {
    if (node['testcase'] !== undefined) {
      cases.push({
        attributes: attributesOf(node),
        children: elements(node['testcase']),
        describes: [...describes],
      })
    } else if (node['testsuite'] !== undefined) {
      const name = stringAttribute(attributesOf(node), 'name') ?? ''
      collectCases(
        elements(node['testsuite']),
        inFile ? [...describes, name] : describes,
        true,
        cases,
      )
    } else if (node['testsuites'] !== undefined) {
      collectCases(elements(node['testsuites']), describes, inFile, cases)
    }
  }
}

function stateOf(
  children: readonly Record<string, unknown>[],
): BunCase['state'] {
  if (
    children.some(
      (child) => child['failure'] !== undefined || child['error'] !== undefined,
    )
  ) {
    return 'failed'
  }
  return children.some((child) => child['skipped'] !== undefined)
    ? 'skipped'
    : 'passed'
}

/**
 * Cases from Bun's JUnit report, in report order; a testcase needs `name` and
 * `file`. A `<failure>` or `<error>` child fails the case and `<skipped>`
 * skips it (Bun also lists every case a name pattern left out as skipped).
 * `fullName` includes enclosing `describe` blocks separated by spaces, which is
 * the string Bun matches against `--test-name-pattern`. Throws when the report
 * is not well-formed XML.
 */
export function parseBunJunit(root: string, xml: string): BunCase[] {
  let document: unknown
  try {
    document = parser.parse(xml, true)
  } catch (cause) {
    throw new Error('The bun JUnit report is not well-formed XML', { cause })
  }
  const reported: ReportedCase[] = []
  collectCases(elements(document), [], false, reported)
  const cases: BunCase[] = []
  for (const { attributes, children, describes } of reported) {
    const name = stringAttribute(attributes, 'name')
    const sourceFile = stringAttribute(attributes, 'file')
    if (name === undefined || sourceFile === undefined) continue
    const absoluteFile = resolve(root, sourceFile)
    if (!isInside(root, absoluteFile)) continue
    const file = slash(relative(root, absoluteFile))
    const line = Number(stringAttribute(attributes, 'line') ?? 1)
    const duration = Number(stringAttribute(attributes, 'time') ?? 0) * 1_000
    const fullName =
      describes.length === 0 ? name : `${describes.join(' ')} ${name}`
    cases.push({
      ...(describes.length === 0 ? {} : { describes }),
      ...(Number.isFinite(duration) ? { duration } : {}),
      file,
      fullName,
      id: bunTestId(file, line, fullName),
      line,
      state: stateOf(children),
    })
  }
  return cases
}

/** Project files with any executed line in an lcov report, root-relative and sorted. */
export function parseBunLcov(root: string, lcov: string): string[] {
  const files = new Set<string>()
  for (const record of lcov.split('end_of_record')) {
    const source = /^SF:(.+)$/mu.exec(record)?.[1]
    const covered = [...record.matchAll(/^DA:\d+,(\d+)/gmu)].some(
      (match) => Number(match[1]) > 0,
    )
    if (source === undefined || !covered) continue
    const absoluteFile = resolve(root, source)
    if (isInside(root, absoluteFile)) {
      files.add(slash(relative(root, absoluteFile)))
    }
  }
  return [...files].sort(byCodeUnit)
}
