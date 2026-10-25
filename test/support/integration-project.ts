import { execFileSync, spawn, spawnSync } from 'node:child_process'
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
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as NodeServices from '@effect/platform-node/NodeServices'

import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import { GraphStore } from '../../src/engine/ports.ts'
import { GraphStoreLive } from '../../src/engine/state/graph-store.ts'

export const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
)
export const packageName = '@lucasacoutinho/tiacore'

const temporaryDirectories: string[] = []
const fixtureRoot = resolve(packageRoot, 'test/fixtures')

interface ProjectOptions {
  configImports?: string
  copyPackage?: boolean
  extraFiles?: Record<string, string>
  extraPlugins?: string
  include?: string
  linkPackage?: boolean
  packageImport?: boolean
  pluginOptions?: string
  testA?: string
  testB?: string
  testConfig?: string
}

export interface CommandResult {
  output: string
  signal: NodeJS.Signals | null
  status: number | null
}

function childEnvironment(
  environment: Record<string, string>,
): NodeJS.ProcessEnv {
  const inherited = { ...process.env }
  delete inherited.TIA
  delete inherited.TIA_FRESH

  return {
    ...inherited,
    ...environment,
    NO_COLOR: '1',
  }
}

export function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

export function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

export function createProject(options: ProjectOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-integration-'))
  temporaryDirectories.push(root)
  const pluginSpecifier = options.packageImport
    ? `${packageName}/vitest`
    : options.copyPackage || options.linkPackage
      ? packageName
      : pathToFileURL(join(packageRoot, 'dist/entries/index.js')).href

  write(
    join(root, '.gitignore'),
    'node_modules\n.tia/\ncoverage/\nexecutions.log\nsetup.log\ncustom-reporter.log\n',
  )
  write(join(root, 'package.json'), '{"private":true,"type":"module"}\n')
  write(
    join(root, 'vitest.config.ts'),
    `import { defineConfig } from 'vitest/config'
import { tia } from '${pluginSpecifier}'
${options.configImports ?? ''}

export default defineConfig({
  plugins: [${options.extraPlugins ?? ''}tia(${options.pluginOptions ?? '{ log: true }'})],
  test: {
    include: ${options.include ?? "['test/**/*.test.ts']"},
    ${options.testConfig ?? ''}
  },
})
`,
  )
  write(join(root, 'src/a.ts'), "export const a = () => 'a'\n")
  write(join(root, 'src/b.ts'), "export const b = () => 'b'\n")
  write(
    join(root, 'test/a.test.ts'),
    options.testA ??
      `import { appendFileSync } from 'node:fs'
import { test, expect } from 'vitest'

test('a through a dynamic import', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'a\\n')
  const { a } = await import('../src/a')
  expect(a()).toBe('a')
})
`,
  )
  write(
    join(root, 'test/b.test.ts'),
    options.testB ??
      `import { appendFileSync } from 'node:fs'
import { test, expect } from 'vitest'

test('b', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'b\\n')
  const { b } = await import('../src/b')
  expect(b()).toBe('b')
})
`,
  )

  for (const [path, contents] of Object.entries(options.extraFiles ?? {})) {
    write(join(root, path), contents)
  }

  if (options.copyPackage || options.linkPackage) {
    mkdirSync(join(root, 'node_modules'))

    for (const dependency of [
      '@playwright',
      '@testing-library',
      '@vitejs',
      '@vitest',
      'istanbul-lib-instrument',
      'ejs',
      'jsdom',
      'picomatch',
      'playwright',
      'react',
      'react-dom',
      'vite',
      'vitest',
    ]) {
      const destination = join(root, 'node_modules', dependency)
      mkdirSync(dirname(destination), { recursive: true })
      symlinkSync(join(packageRoot, 'node_modules', dependency), destination)
    }

    const packageDestination = join(
      root,
      'node_modules',
      ...packageName.split('/'),
    )
    mkdirSync(dirname(packageDestination), { recursive: true })
    if (options.copyPackage) {
      mkdirSync(packageDestination)
      cpSync(join(packageRoot, 'dist'), join(packageDestination, 'dist'), {
        recursive: true,
      })
      cpSync(
        join(packageRoot, 'package.json'),
        join(packageDestination, 'package.json'),
      )
    } else {
      symlinkSync(packageRoot, packageDestination)
    }
  } else if (options.packageImport) {
    mkdirSync(join(root, 'node_modules'))
    symlinkSync(
      join(packageRoot, 'node_modules/vitest'),
      join(root, 'node_modules/vitest'),
    )
    const packageDestination = join(
      root,
      'node_modules',
      ...packageName.split('/'),
    )
    mkdirSync(dirname(packageDestination), { recursive: true })
    symlinkSync(packageRoot, packageDestination)
  } else {
    symlinkSync(join(packageRoot, 'node_modules'), join(root, 'node_modules'))
  }
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'tia@example.test'])
  git(root, ['config', 'user.name', 'TIA'])
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'baseline'])
  return root
}

export function createFixtureProject(name: string): string {
  const source = resolve(fixtureRoot, name)
  if (!source.startsWith(`${fixtureRoot}/`) || !existsSync(source)) {
    throw new Error(`Unknown integration fixture: ${name}`)
  }

  const root = mkdtempSync(join(tmpdir(), `tiacore-${name}-`))
  temporaryDirectories.push(root)
  cpSync(source, root, { recursive: true })
  mkdirSync(join(root, 'node_modules'))

  for (const dependency of [
    '@playwright',
    '@testing-library',
    '@vitejs',
    '@vitest',
    'istanbul-lib-instrument',
    'ejs',
    'jsdom',
    'picomatch',
    'playwright',
    'react',
    'react-dom',
    'vite',
    'vitest',
  ]) {
    const destination = join(root, 'node_modules', dependency)
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(join(packageRoot, 'node_modules', dependency), destination)
  }
  const packageDestination = join(
    root,
    'node_modules',
    ...packageName.split('/'),
  )
  mkdirSync(dirname(packageDestination), { recursive: true })
  symlinkSync(packageRoot, packageDestination)

  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'tia@example.test'])
  git(root, ['config', 'user.name', 'TIA'])
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'baseline'])
  return root
}

export function createLinkedWorktree(root: string, name: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'tiacore-worktree-'))
  temporaryDirectories.push(parent)
  const target = join(parent, 'checkout')
  git(root, [
    'worktree',
    'add',
    '-q',
    '-b',
    `tiacore-${name}-${process.pid}-${Date.now()}`,
    target,
  ])
  symlinkSync(join(packageRoot, 'node_modules'), join(target, 'node_modules'))
  return target
}

export function cloneProjectWithGraph(source: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'tiacore-clone-'))
  temporaryDirectories.push(parent)
  const root = join(parent, 'project')

  execFileSync('git', ['clone', '-q', source, root], { stdio: 'ignore' })
  symlinkSync(join(packageRoot, 'node_modules'), join(root, 'node_modules'))
  cpSync(join(source, '.tia'), join(root, '.tia'), {
    recursive: true,
  })
  return root
}

export function runVitest(
  root: string,
  args: string[] = ['run'],
  timeout = 20_000,
  environment: Record<string, string> = {},
): CommandResult {
  const result = spawnSync(
    process.execPath,
    [join(packageRoot, 'node_modules/vitest/vitest.mjs'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: childEnvironment(environment),
      timeout,
    },
  )

  return {
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    signal: result.signal,
    status: result.status,
  }
}

export function runVitestAsync(
  root: string,
  args: string[] = ['run'],
  timeout = 20_000,
  environment: Record<string, string> = {},
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [join(packageRoot, 'node_modules/vitest/vitest.mjs'), ...args],
      {
        cwd: root,
        env: childEnvironment(environment),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, timeout)

    child.stdout.on('data', (value) => {
      output += String(value)
    })
    child.stderr.on('data', (value) => {
      output += String(value)
    })
    child.on('error', reject)
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolveResult({ output, signal, status })
    })
  })
}

export function runCommand(
  root: string,
  command: string,
  args: string[],
  timeout = 20_000,
  environment: Record<string, string> = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: childEnvironment(environment),
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

const storeLayer = Effect.provide(
  GraphStoreLive.pipe(Layer.provide(NodeServices.layer)),
)

/** Reads the runtime graph stored in `directory`, or null. */
export async function readGraphAt(
  directory: string,
): Promise<TiaRuntimeGraph | null> {
  const { graph } = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* GraphStore
      return yield* store.read(directory)
    }).pipe(storeLayer),
  )
  return graph
}

/** Stores `graph` in `directory`, replacing whatever is there. */
export async function writeGraphAt(
  directory: string,
  graph: TiaRuntimeGraph,
): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* GraphStore
      const current = yield* store.read(directory)
      yield* store.commit(directory, {
        expected: current.graph,
        expectedDigest: current.digest,
        graph,
      })
    }).pipe(storeLayer),
  )
}

export async function readGraph(
  root: string,
  runner?: 'bun' | 'node',
): Promise<TiaRuntimeGraph> {
  const { graph } = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* GraphStore
      return yield* store.read(
        join(root, '.tia', ...(runner === undefined ? [] : [runner])),
      )
    }).pipe(storeLayer),
  )
  if (graph === null) throw new Error('expected a valid TIA runtime state')
  return graph
}

export function cleanupProjects(): void {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { force: true, recursive: true })
  }
}
