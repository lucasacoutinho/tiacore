import { relative } from 'node:path'

import { isObject } from '../shared/json.ts'

import { isInside, slash } from '../../engine/host-path.ts'
import { canonicalNodePath } from './paths.ts'

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

/** `node:test` programmatic coverage needs 22.10. */
export function nodeVersionSupported(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 10)
}

/**
 * Non-executing discovery needs `module.registerHooks` (22.15). Below that,
 * or with `TIACORE_NODE_DISCOVERY_HOOKS=0`, the runner aggregates.
 */
export function nodeDiscoveryHooksSupported(
  version = process.versions.node,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (environment['TIACORE_NODE_DISCOVERY_HOOKS'] === '0') return false
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 15)
}

/** The persisted node:test id: `<file>:<line>:<column>:<fullName>`. */
export function nodeTestId(
  file: string,
  line: number,
  column: number,
  name: string,
): string {
  return `${file}:${line}:${column}:${name}`
}

interface NodeDiscoveryRecord {
  readonly column: number
  readonly file: string
  readonly fullName: string
  readonly line: number
  readonly name: string
  readonly skipped: boolean
}

function parseRecord(line: string): NodeDiscoveryRecord | null {
  const value: unknown = JSON.parse(line)
  if (!isObject(value)) return null
  const { column, file, fullName, line: row, name, skipped } = value
  if (
    typeof file !== 'string' ||
    typeof fullName !== 'string' ||
    typeof name !== 'string' ||
    typeof row !== 'number' ||
    typeof column !== 'number'
  ) {
    return null
  }
  return { column, file, fullName, line: row, name, skipped: skipped === true }
}

/** Cases from the shim's JSON-lines output; records outside the root or unparsable are dropped. */
export function parseNodeDiscoveryRecords(
  root: string,
  source: string,
): NodeCase[] {
  const canonicalRoot = canonicalNodePath(root)
  return source
    .split('\n')
    .filter(Boolean)
    .flatMap((line): NodeCase[] => {
      try {
        const record = parseRecord(line)
        if (record === null) return []
        const absoluteFile = canonicalNodePath(record.file)
        if (!isInside(canonicalRoot, absoluteFile)) return []
        const file = slash(relative(canonicalRoot, absoluteFile))
        return [
          {
            column: record.column,
            file,
            fullName: record.fullName,
            id: nodeTestId(file, record.line, record.column, record.fullName),
            line: record.line,
            name: record.name,
            state: record.skipped ? 'skipped' : 'passed',
          },
        ]
      } catch {
        return []
      }
    })
}
