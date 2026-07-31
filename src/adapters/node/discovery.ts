import { relative, resolve } from 'node:path'

import { isInside, slash } from '../../shared/paths.js'

export interface NodeCase {
  column: number
  duration?: number
  file: string
  fullName: string
  id: string
  line: number
  name: string
  state: 'failed' | 'passed' | 'skipped'
}

export interface NodeExecution {
  cases: NodeCase[]
  coverageFiles: string[]
  moduleFailures: string[]
  success: boolean
}

export interface NodeDiscovery extends NodeExecution {
  aggregate: boolean
}

interface NodeDiscoveryRecord {
  column: number
  file: string
  fullName: string
  line: number
  name: string
  skipped: boolean
}

export function nodeDiscoveryHooksSupported(): boolean {
  if (process.env.TIACORE_NODE_DISCOVERY_HOOKS === '0') return false
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 15)
}

function testId(
  file: string,
  line: number,
  column: number,
  name: string,
): string {
  return `${file}:${line}:${column}:${name}`
}

export function parseNodeDiscoveryRecords(
  root: string,
  source: string,
): NodeCase[] {
  return source
    .split('\n')
    .filter(Boolean)
    .flatMap((line): NodeCase[] => {
      try {
        const record = JSON.parse(line) as NodeDiscoveryRecord
        const absoluteFile = resolve(record.file)
        if (!isInside(root, absoluteFile)) return []
        const file = slash(relative(root, absoluteFile))
        return [{
          column: record.column,
          file,
          fullName: record.fullName,
          id: testId(file, record.line, record.column, record.fullName),
          line: record.line,
          state: record.skipped ? 'skipped' : 'passed',
          name: record.name,
        }]
      } catch {
        return []
      }
    })
}
