import { relative, resolve } from 'node:path'

import { isInside, slash } from '../../shared/paths.js'

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
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(source)
  return match === null ? null : decodeXml(match[1] ?? '')
}

function testId(file: string, line: number, name: string): string {
  return `${file}:${line}:${name}`
}

export function parseBunJunit(root: string, xml: string): BunCase[] {
  const cases: BunCase[] = []
  const expression = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
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
      id: testId(file, line, name),
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

export function parseBunLcov(root: string, lcov: string): string[] {
  const files = new Set<string>()
  for (const record of lcov.split('end_of_record')) {
    const source = /^SF:(.+)$/m.exec(record)?.[1]
    const covered = [...record.matchAll(/^DA:\d+,(\d+)/gm)].some(
      (match) => Number(match[1]) > 0,
    )
    if (source === undefined || !covered) continue
    const absoluteFile = resolve(root, source)
    if (isInside(root, absoluteFile)) {
      files.add(slash(relative(root, absoluteFile)))
    }
  }
  return [...files].sort()
}
