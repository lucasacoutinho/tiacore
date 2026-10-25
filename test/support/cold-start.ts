import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Cold start of the engine in a git project: the first prepare and the first
// commit of a fresh process, with no stored graph. Each run is its own process
// because a warm process hides what a user waits for: module loading, building
// the runtime and spawning git for the first time.

export const current = fileURLToPath(
  new URL('../../dist/entries/core.js', import.meta.url),
)
export const old = fileURLToPath(
  new URL(
    '../../node_modules/tiacore-v1/dist/entries/core.js',
    import.meta.url,
  ),
)

const TEST_FILES = 40

/**
 * Runs the engine in this process, counting the child processes it starts.
 * Child processes are counted by wrapping `child_process` before the engine is
 * imported, so every way of starting one is seen. The mode picks the phases:
 *
 * - `cold`: a first prepare and commit, with no stored graph (the default).
 * - `second`: `cold`, then one source file changes and a second prepare runs in
 *   the same process, as in a watch-mode rerun or a second Vitest project.
 * - `prepare`: only a prepare, in a project that already has a stored graph
 *   and one changed file, as in a second `vitest run`.
 */
const CHILD = `
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [entry, root, mode = 'cold'] = process.argv.slice(1)
const spawned = []
for (const name of ['spawn', 'execFile', 'execFileSync', 'spawnSync']) {
  const original = cp[name]
  cp[name] = function (...args) {
    spawned.push(String(args[0]))
    return original.apply(this, args)
  }
}
syncBuiltinESMExports()

const started = performance.now()
const { TiaCore } = await import(entry)
const imported = performance.now()
const tests = readdirSync(join(root, 'test')).map((file) => 'test/' + file)
const options = {
  files: ['test/**/*.test.ts'],
  fresh: false,
  log: false,
  root,
  runner: 'custom',
  testFiles: tests,
}
const summary = (plan) => ({ affected: plan.affectedTests.length, mode: plan.mode })
const core = new TiaCore(options)
const plan = await core.prepare()
const prepared = performance.now()
const afterPrepare = spawned.length
const result = {
  import: imported - started,
  plan: summary(plan),
  prepare: prepared - imported,
  prepareSpawns: spawned.slice(0, afterPrepare),
}
if (mode !== 'prepare') {
  await core.commit(
    tests.map((file) => ({
      file,
      files: [file.replace('test/', 'src/').replace('.test', ''), file],
      fullName: file,
      id: file,
      state: 'passed',
    })),
    tests,
  )
  const committed = performance.now()
  result.commit = committed - prepared
  result.commitSpawns = spawned.slice(afterPrepare)
  if (mode === 'second') {
    writeFileSync(join(root, 'src', 'm0.ts'), 'export const value = "second"\\n')
    const beforeSecond = spawned.length
    const again = performance.now()
    const second = await new TiaCore(options).prepare()
    result.second = performance.now() - again
    result.secondPlan = summary(second)
    result.secondSpawns = spawned.slice(beforeSecond)
  }
}
console.log(JSON.stringify(result))
`

export interface PlanSummary {
  readonly affected: number
  readonly mode: string
}

export interface Cold {
  readonly commit: number
  readonly commitSpawns: readonly string[]
  readonly import: number
  readonly plan: PlanSummary
  readonly prepare: number
  readonly prepareSpawns: readonly string[]
  /** Mode `second` only: the second prepare, after one file changed. */
  readonly second?: number
  readonly secondPlan?: PlanSummary
  readonly secondSpawns?: readonly string[]
}

/** A prepare in a project that already has a stored graph (mode `prepare`). */
export interface Reuse {
  readonly import: number
  readonly plan: PlanSummary
  readonly prepare: number
  readonly prepareSpawns: readonly string[]
}

/** A project of test files, in a repository, that cold runs copy. */
export interface ColdTemplate {
  readonly base: string
  /** The directory every run copies. */
  readonly template: string
  readonly testFiles: number
}

let counter = 0

function vcs(directory: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=tiacore',
      '-c',
      'user.email=cold@tiacore.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: directory, stdio: 'ignore' },
  )
}

/** Builds a project of `testFiles` test files, each importing its own source. */
export function buildColdTemplate(testFiles: number): ColdTemplate {
  for (const entry of [current, old]) {
    if (!existsSync(entry)) {
      throw new Error(`${entry} is missing; run npm ci and npm run build`)
    }
  }
  const base = mkdtempSync(join(tmpdir(), 'tiacore-cold-'))
  const template = join(base, 'template')
  mkdirSync(join(template, 'src'), { recursive: true })
  mkdirSync(join(template, 'test'), { recursive: true })
  writeFileSync(join(template, '.gitignore'), '.tia/\n')
  writeFileSync(join(template, 'package.json'), '{"type":"module"}\n')
  for (let index = 0; index < testFiles; index += 1) {
    writeFileSync(
      join(template, 'src', `m${index}.ts`),
      `export const value = ${index}\n`,
    )
    writeFileSync(
      join(template, 'test', `m${index}.test.ts`),
      `import { value } from '../src/m${index}.ts'\nvalue\n`,
    )
  }
  vcs(template, 'init', '-q')
  vcs(template, 'add', '.')
  vcs(template, 'commit', '-q', '-m', 'baseline')
  return { base, template, testFiles }
}

/** Removes a template and every copy. */
export function dropColdTemplate(project: ColdTemplate): void {
  rmSync(project.base, { force: true, recursive: true })
}

function childOutput<T>(entry: string, root: string, mode: string): T {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', CHILD, pathToFileURL(entry).href, root, mode],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(result.stderr)
  const line = result.stdout.trim().split('\n').at(-1) ?? ''
  return JSON.parse(line)
}

function copyOf(project: ColdTemplate, source = project.template): string {
  counter += 1
  const root = join(project.base, `run-${counter}`)
  cpSync(source, root, { recursive: true })
  return root
}

/** One run of `mode` in a fresh process on a fresh copy of the project. */
export function coldRun(
  project: ColdTemplate,
  entry: string,
  mode: 'cold' | 'second' = 'cold',
): Cold {
  const root = copyOf(project)
  try {
    return childOutput<Cold>(entry, root, mode)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

/**
 * A copy of the project after a recorded run of `entry`: the stored graph is
 * in `.tia` and the history in `.git`. It lives under the template's base and
 * goes with `dropColdTemplate`.
 */
export function recordedProject(project: ColdTemplate, entry: string): string {
  const root = copyOf(project)
  childOutput(entry, root, 'cold')
  return root
}

/**
 * One fresh process preparing in a copy of a recorded project in which the
 * source of the first test file changed: the second `vitest run` of a day.
 */
export function reusedRun(
  project: ColdTemplate,
  recorded: string,
  entry: string,
): Reuse {
  const root = copyOf(project, recorded)
  try {
    writeFileSync(
      join(root, 'src', 'm0.ts'),
      'export const value = "changed"\n',
    )
    return childOutput<Reuse>(entry, root, 'prepare')
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

export function spawnedBy(run: Cold): number {
  return run.prepareSpawns.length + run.commitSpawns.length
}

// The template of the correctness suite's cold-start tests: 40 test files.
let shared: ColdTemplate | undefined

/** Builds the 40-file project the `cold` helper copies. */
export function createColdTemplate(): void {
  shared = buildColdTemplate(TEST_FILES)
}

/** Removes the shared template and every copy. */
export function removeColdTemplate(): void {
  if (shared !== undefined) dropColdTemplate(shared)
}

/** One cold run in a fresh process on a fresh copy of the shared project. */
export function cold(entry: string): Cold {
  if (shared === undefined) throw new Error('createColdTemplate was not called')
  return coldRun(shared, entry)
}
