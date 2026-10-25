import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as Cause from 'effect/Cause'

import { VERSION } from '../core/version.ts'

const SECRET_FLAG = /token|secret|password|passwd|credential|auth|key/iu

/** Replaces the values of secret-looking flags (`--token x`, `--api-key=x`). */
export function redactArguments(argv: readonly string[]): string[] {
  const redacted: string[] = []
  let hideNext = false
  for (const argument of argv) {
    if (hideNext) {
      redacted.push('<redacted>')
      hideNext = false
      continue
    }
    const equals = argument.indexOf('=')
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    if (flag.startsWith('-') && SECRET_FLAG.test(flag)) {
      if (equals === -1) {
        redacted.push(argument)
        hideNext = true
      } else {
        redacted.push(`${flag}=<redacted>`)
      }
      continue
    }
    redacted.push(argument)
  }
  return redacted
}

/** Most crash reports a directory keeps; the oldest are removed first. */
export const MAX_CRASH_REPORTS = 20

const REPORT_NAME = /^crash-.+\.json$/u

/** Removes the oldest reports beyond `MAX_CRASH_REPORTS`; the names sort by time. */
function pruneReports(directory: string): void {
  try {
    const reports = readdirSync(directory)
      .filter((name) => REPORT_NAME.test(name))
      .sort()
    for (const name of reports.slice(
      0,
      Math.max(0, reports.length - MAX_CRASH_REPORTS),
    )) {
      rmSync(join(directory, name), { force: true })
    }
  } catch {
    // A report that cannot be pruned is still a report.
  }
}

export interface CrashReportOptions {
  readonly argv: readonly string[]
  readonly directory: string
  readonly now: Date
}

/**
 * Writes a crash report for an unexpected failure and returns its path, or
 * undefined when the report cannot be written. Never throws.
 */
export function writeCrashReport(
  cause: Cause.Cause<unknown>,
  options: CrashReportOptions,
): string | undefined {
  const path = join(
    options.directory,
    `crash-${options.now.toISOString().replaceAll(':', '-')}-${process.pid}.json`,
  )
  try {
    mkdirSync(options.directory, { recursive: true })
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          argv: redactArguments(options.argv),
          arch: process.arch,
          cause: Cause.pretty(cause),
          node: process.version,
          platform: process.platform,
          tiacore: VERSION,
          time: options.now.toISOString(),
        },
        null,
        2,
      )}\n`,
    )
    pruneReports(options.directory)
    return path
  } catch {
    return undefined
  }
}
