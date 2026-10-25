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
 * Runs a cold prepare and commit in this process, counting the child processes
 * each starts. Child processes are counted by wrapping `child_process`
 * before the engine is imported, so every way of starting one is seen.
 */
const CHILD = `
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const [entry, root] = process.argv.slice(1)
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
const core = new TiaCore({
  files: ['test/**/*.test.ts'],
  fresh: false,
  log: false,
  root,
  runner: 'custom',
  testFiles: tests,
})
await core.prepare()
const prepared = performance.now()
const afterPrepare = spawned.length
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
console.log(
  JSON.stringify({
    commit: committed - prepared,
    commitSpawns: spawned.slice(afterPrepare),
    import: imported - started,
    prepare: prepared - imported,
    prepareSpawns: spawned.slice(0, afterPrepare),
  }),
)
`

export interface Cold {
  readonly commit: number
  readonly commitSpawns: readonly string[]
  readonly import: number
  readonly prepare: number
  readonly prepareSpawns: readonly string[]
}

let base = ''
let template = ''
let counter = 0

function vcs(...args: string[]): void {
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
    { cwd: template, stdio: 'ignore' },
  )
}

/** Builds the git project every cold run copies. Call once before `cold`. */
export function createColdTemplate(): void {
  for (const entry of [current, old]) {
    if (!existsSync(entry)) {
      throw new Error(`${entry} is missing; run npm ci and npm run build`)
    }
  }
  base = mkdtempSync(join(tmpdir(), 'tiacore-cold-'))
  template = join(base, 'template')
  mkdirSync(join(template, 'src'), { recursive: true })
  mkdirSync(join(template, 'test'), { recursive: true })
  writeFileSync(join(template, '.gitignore'), '.tia/\n')
  writeFileSync(join(template, 'package.json'), '{"type":"module"}\n')
  for (let index = 0; index < TEST_FILES; index += 1) {
    writeFileSync(
      join(template, 'src', `m${index}.ts`),
      `export const value = ${index}\n`,
    )
    writeFileSync(
      join(template, 'test', `m${index}.test.ts`),
      `import { value } from '../src/m${index}.ts'\nvalue\n`,
    )
  }
  vcs('init', '-q')
  vcs('add', '.')
  vcs('commit', '-q', '-m', 'baseline')
}

/** Removes the template and every copy. */
export function removeColdTemplate(): void {
  rmSync(base, { force: true, recursive: true })
}

export function spawnedBy(run: Cold): number {
  return run.prepareSpawns.length + run.commitSpawns.length
}

/** One cold run in a fresh process on a fresh copy of the project. */
export function cold(entry: string): Cold {
  counter += 1
  const root = join(base, `run-${counter}`)
  cpSync(template, root, { recursive: true })
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', CHILD, pathToFileURL(entry).href, root],
      { encoding: 'utf8' },
    )
    if (result.status !== 0) throw new Error(result.stderr)
    const line = result.stdout.trim().split('\n').at(-1) ?? ''
    return JSON.parse(line)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}
