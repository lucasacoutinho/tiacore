import { dirname, join, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import { NODE_ENGINES, PEER_RANGES, VERSION } from '../core/version.ts'
import { inheritedEnvironment, runProcess } from '../engine/process.ts'
import { observeConfig } from '../host/observe.ts'
import { satisfiesRange } from './semver-range.ts'

export type CheckStatus = 'fail' | 'info' | 'ok' | 'warn'

export interface DoctorCheck {
  readonly detail: string
  readonly id: string
  readonly status: CheckStatus
  readonly title: string
}

export interface DoctorOptions {
  readonly cacheDir: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly nodeVersion: string
}

const check = (
  id: string,
  title: string,
  status: CheckStatus,
  detail: string,
): DoctorCheck => ({ detail, id, status, title })

/** Runs `git <args>` in `cwd`; a git that cannot start is a TiaIo failure. */
export const runGit = (args: readonly string[], cwd: string) =>
  runProcess({
    args,
    command: 'git',
    cwd,
    env: inheritedEnvironment(),
    stdio: 'capture',
  })

/** The trimmed output of `git <args>`, or null if git is missing or fails. */
const gitText = (args: readonly string[], cwd: string) =>
  runGit(args, cwd).pipe(
    Effect.map((outcome) =>
      outcome.code === 0 ? outcome.output.trim() : null,
    ),
    Effect.orElseSucceed(() => null),
  )

export function nodeCheck(nodeVersion: string): DoctorCheck {
  const supported = satisfiesRange(nodeVersion, NODE_ENGINES)
  return supported === true
    ? check('node', 'Node.js', 'ok', `${nodeVersion} satisfies ${NODE_ENGINES}`)
    : supported === false
      ? check(
          'node',
          'Node.js',
          'fail',
          `${nodeVersion} does not satisfy ${NODE_ENGINES}; install a supported Node.js`,
        )
      : check('node', 'Node.js', 'warn', `cannot compare ${nodeVersion}`)
}

const gitChecks = Effect.fnUntraced(function* (cwd: string) {
  const version = yield* gitText(['--version'], cwd)
  if (version === null) {
    return [
      check(
        'git',
        'git',
        'warn',
        'git was not found on PATH; tiacore falls back to file snapshots, which are slower',
      ),
    ]
  }
  const inside = yield* gitText(['rev-parse', '--is-inside-work-tree'], cwd)
  return [
    check('git', 'git', 'ok', version),
    inside === 'true'
      ? check('repository', 'Git repository', 'ok', `${cwd} is in a work tree`)
      : check(
          'repository',
          'Git repository',
          'info',
          `${cwd} is not in a git work tree`,
        ),
  ]
})

/** The `version` field of a package.json text, or null when it is damaged or has none. */
function manifestVersion(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version
    }
  } catch {
    // A damaged manifest counts as not installed.
  }
  return null
}

/** The `version` of `<directory>/node_modules/<name>/package.json`, looking upward from `cwd`. */
const installedVersion = Effect.fnUntraced(function* (
  name: string,
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem
  let directory = resolve(cwd)
  for (;;) {
    const manifest = join(directory, 'node_modules', name, 'package.json')
    const text = yield* fs
      .readFileString(manifest)
      .pipe(Effect.orElseSucceed(() => null))
    if (text !== null) return manifestVersion(text)
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
})

const peerChecks = Effect.fnUntraced(function* (cwd: string) {
  const checks: DoctorCheck[] = []
  for (const [name, range] of Object.entries(PEER_RANGES)) {
    const version = yield* installedVersion(name, cwd)
    if (version === null) {
      checks.push(
        check(
          `peer:${name}`,
          name,
          'info',
          `not installed; needed only for the ${name} integration (supported ${range})`,
        ),
      )
      continue
    }
    const supported = satisfiesRange(version, range)
    checks.push(
      supported === true
        ? check(`peer:${name}`, name, 'ok', `${version} satisfies ${range}`)
        : supported === false
          ? check(
              `peer:${name}`,
              name,
              'fail',
              `${version} does not satisfy ${range}`,
            )
          : check(`peer:${name}`, name, 'warn', `cannot compare ${version}`),
    )
  }
  const typescript = yield* installedVersion('typescript', cwd)
  checks.push(
    typescript === null
      ? check(
          'typescript',
          'typescript',
          'info',
          'not installed; tiacore does not need it',
        )
      : check('typescript', 'typescript', 'ok', `${typescript} found`),
  )
  return checks
})

/**
 * Whether tiacore could write `path`, judged without writing: the path itself
 * when it exists, otherwise the nearest parent that does.
 */
export const writableCheck = Effect.fnUntraced(function* (
  id: string,
  title: string,
  path: string,
) {
  const fs = yield* FileSystem.FileSystem
  let directory = resolve(path)
  while (
    !(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false)))
  ) {
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const writable = yield* fs.access(directory, { writable: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
  const existing = directory === resolve(path)
  if (!writable) {
    return check(id, title, 'fail', `${directory} is not writable`)
  }
  return check(
    id,
    title,
    'ok',
    existing
      ? `${directory} is writable`
      : `${path} does not exist yet; ${directory} is writable`,
  )
})

const observabilityCheck = (
  env: Readonly<Record<string, string | undefined>>,
): DoctorCheck => {
  const config = observeConfig(env)
  const active = Object.entries(config).map(([key, value]) => `${key}=${value}`)
  return active.length === 0
    ? check(
        'observability',
        'Observability',
        'info',
        'off; see docs/observability.md to turn it on',
      )
    : check('observability', 'Observability', 'info', active.join(', '))
}

/** The self-check: Node.js, git, peers and writable directories. Never writes. */
export const selfCheck = Effect.fnUntraced(function* (options: DoctorOptions) {
  const crashDirectory =
    options.env['TIACORE_CRASH_DIR'] ?? join(options.cwd, '.tia', 'crashes')
  return [
    check(
      'tiacore',
      'tiacore',
      'ok',
      `${VERSION} on ${process.platform}/${process.arch}`,
    ),
    nodeCheck(options.nodeVersion),
    ...(yield* gitChecks(options.cwd)),
    ...(yield* peerChecks(options.cwd)),
    yield* writableCheck(
      'cache',
      'Cache directory',
      resolve(options.cwd, options.cacheDir),
    ),
    yield* writableCheck('crash', 'Crash report directory', crashDirectory),
    observabilityCheck(options.env),
  ]
})
