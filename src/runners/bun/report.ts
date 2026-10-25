import { relative, resolve } from 'node:path'

import { byCodeUnit } from '../../core/canonical.ts'
import { isInside, slash } from '../../engine/host-path.ts'

export interface BunCase {
  duration?: number
  file: string
  fullName: string
  id: string
  line: number
  state: 'failed' | 'passed' | 'skipped'
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function attribute(source: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(source)
  return match === null ? null : decodeXml(match[1] ?? '')
}

/** The persisted bun:test id: `<file>:<line>:<name>` (Bun reports no column). */
export function bunTestId(file: string, line: number, name: string): string {
  return `${file}:${line}:${name}`
}

/**
 * Cases from Bun's JUnit report. The report is scanned with a regular
 * expression, not an XML parser; a testcase needs `name` and `file`. The
 * enclosing describe in `classname` is ignored, so `fullName` is the leaf name.
 */
export function parseBunJunit(root: string, xml: string): BunCase[] {
  const cases: BunCase[] = []
  const expression = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu
  for (const match of xml.matchAll(expression)) {
    const attributes = match[1] ?? ''
    const body = match[2] ?? ''
    const name = attribute(attributes, 'name')
    const sourceFile = attribute(attributes, 'file')
    if (name === null || sourceFile === null) continue
    const absoluteFile = resolve(root, sourceFile)
    if (!isInside(root, absoluteFile)) continue
    const file = slash(relative(root, absoluteFile))
    const line = Number(attribute(attributes, 'line') ?? 1)
    const duration = Number(attribute(attributes, 'time') ?? 0) * 1_000
    cases.push({
      ...(Number.isFinite(duration) ? { duration } : {}),
      file,
      fullName: name,
      id: bunTestId(file, line, name),
      line,
      state: body.includes('<failure')
        ? 'failed'
        : body.includes('<skipped')
          ? 'skipped'
          : 'passed',
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
