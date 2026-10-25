import { readFileSync } from 'node:fs'

import { byCodeUnit } from '../../core/canonical.ts'
import type { PlaywrightObservation, PlaywrightRunReport } from './protocol.ts'

const STATUSES = new Set(['failed', 'interrupted', 'passed', 'timedout'])
const STATES = new Set(['failed', 'passed', 'skipped'])

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function observation(value: unknown): value is PlaywrightObservation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dependenciesComplete' in value &&
    typeof value.dependenciesComplete === 'boolean' &&
    'file' in value &&
    typeof value.file === 'string' &&
    'files' in value &&
    strings(value.files) &&
    'fullName' in value &&
    typeof value.fullName === 'string' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'state' in value &&
    typeof value.state === 'string' &&
    STATES.has(value.state) &&
    (!('duration' in value) ||
      value.duration === undefined ||
      typeof value.duration === 'number')
  )
}

function runReport(value: unknown): value is PlaywrightRunReport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'configuredTestIds' in value &&
    strings(value.configuredTestIds) &&
    'observations' in value &&
    Array.isArray(value.observations) &&
    value.observations.every(observation) &&
    'status' in value &&
    typeof value.status === 'string' &&
    STATUSES.has(value.status)
  )
}

/** The reporter's session file, or null when it is missing or not a report. */
export function readReport(path: string): PlaywrightRunReport | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return runReport(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Why a run's report cannot update the graph; empty when it can. A graph
 * built from a partial run would let an unobserved spec be treated as cached,
 * so each of these blocks the commit, and each says why.
 */
export function evidenceProblems(
  report: PlaywrightRunReport | null,
  root: string,
): string[] {
  if (report === null) {
    return [
      'Playwright wrote no report (it did not start, found no tests, or the reporter from tia() is not in the config)',
    ]
  }
  const problems: string[] = []
  if (report.status === 'interrupted' || report.status === 'timedout') {
    problems.push(`the Playwright run was ${report.status}`)
  }
  const plain = [
    ...new Set(
      report.observations
        .filter((entry) => !entry.dependenciesComplete)
        .map((entry) => entry.file),
    ),
  ].sort(byCodeUnit)
  if (plain.length > 0) {
    problems.push(
      `no dependency evidence from ${plain.join(', ')}; build the spec's test from tia(test) so its fixture records dependencies`,
    )
  }
  const observed = new Set(
    report.observations.map((entry) => entry.id.replace(/^playwright:/u, '')),
  )
  const missing = report.configuredTestIds.filter((id) => !observed.has(id))
  if (missing.length > 0) {
    problems.push(
      `${missing.length} configured test${
        missing.length === 1 ? '' : 's'
      } produced no result inside ${root} (the run stopped early, or a spec lives outside the project root)`,
    )
  }
  return problems
}
