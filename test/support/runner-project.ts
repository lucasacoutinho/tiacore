import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import { GraphStore } from '../../src/engine/ports.ts'
import { EngineLive } from '../engine/support/layers.ts'

// Fixture projects for the runner tests: a copy of test/fixtures/<name> in a
// temporary git repository, with the built package linked into node_modules so
// `@lucasacoutinho/tiacore/node` resolves to dist.

export const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
)
const fixtureRoot = resolve(packageRoot, 'test/fixtures')
const temporaryDirectories: string[] = []
const runtime = ManagedRuntime.make(EngineLive)

export interface CommandResult {
  output: string
  signal: NodeJS.Signals | null
  status: number | null
}

export function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

export function initRepository(root: string): void {
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'tia@example.test'])
  git(root, ['config', 'user.name', 'TIA'])
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'baseline'])
}

export function createFixtureProject(name: string): string {
  const source = resolve(fixtureRoot, name)
  if (!source.startsWith(`${fixtureRoot}/`) || !existsSync(source)) {
    throw new Error(`Unknown integration fixture: ${name}`)
  }
  const root = mkdtempSync(join(tmpdir(), `tiacore-${name}-`))
  temporaryDirectories.push(root)
  cpSync(source, root, { recursive: true })
  const destination = join(root, 'node_modules', '@lucasacoutinho', 'tiacore')
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(packageRoot, destination)
  writeFileSync(join(root, '.gitignore'), readIgnore(root))
  initRepository(root)
  return root
}

function readIgnore(root: string): string {
  const path = join(root, '.gitignore')
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  return existing.includes('node_modules')
    ? existing
    : `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}node_modules\n`
}

export function runCommand(
  root: string,
  command: string,
  args: string[],
  timeout = 30_000,
  environment: Record<string, string> = {},
): CommandResult {
  const inherited = { ...process.env }
  delete inherited['TIA']
  delete inherited['TIA_FRESH']
  delete inherited['NODE_TEST_CONTEXT']
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...inherited, ...environment, NO_COLOR: '1' },
    timeout,
  })
  return {
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    signal: result.signal,
    status: result.status,
  }
}

export function executions(root: string): string[] {
  const path = join(root, 'executions.log')
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    : []
}

export function resetExecutions(root: string): void {
  writeFileSync(join(root, 'executions.log'), '')
}

/** The runner's stored graph under `<root>/.tia/<runner>`. */
export async function readGraph(
  root: string,
  runner: string,
): Promise<TiaRuntimeGraph> {
  const stored = await runtime.runPromise(
    Effect.flatMap(GraphStore, (store) =>
      store.read(join(root, '.tia', runner)),
    ),
  )
  if (stored.graph === null)
    throw new Error('expected a valid TIA runtime state')
  return stored.graph
}

export function cleanupProjects(): void {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { force: true, recursive: true })
  }
}
