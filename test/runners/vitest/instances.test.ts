import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { VERSION } from '../../../src/core/version.ts'
import { instrumentationHash } from '../../../src/engine/coverage/templates.ts'
import { disposeHost } from '../../../src/host/runtime.ts'
import { tia } from '../../../src/runners/vitest/plugin.ts'
import type { TiaRuntime } from '../../../src/runners/vitest/state.ts'
import {
  cleanupProjects,
  createProject,
  executions,
  packageRoot,
  readGraph,
  runCommand,
  runVitest,
} from '../../support/integration-project.ts'

// Programmatic callers (createVitest twice, IDE integrations, Vitest's own test
// harness) start several Vitest instances in one process. Each one plans from
// the graph the previous one committed and commits its own.

interface Wave {
  executions: string[]
  instances: { failed: number; reporters: number }[]
}

type Step =
  | { append: string }
  | { phase: string }
  | { concurrent?: boolean; wave: { include?: string[] }[] }

const driver = readFileSync(
  join(packageRoot, 'test/fixtures/vitest-instances-driver.mjs'),
  'utf8',
)

/**
 * A test that imports `first` until the phase file says `two`, then `second`,
 * and in phase two takes `delayMs` longer to finish.
 */
function phasedTest(
  name: string,
  first: string,
  second: string,
  delayMs = 0,
): string {
  return `import { appendFileSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('${name}', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), '${name}\\n')
  const phase = readFileSync(new URL('../phase.txt', import.meta.url), 'utf8').trim()
  if (phase === 'two') await new Promise((done) => setTimeout(done, ${delayMs}))
  const loaded = phase === 'two' ? await import('../src/${second}') : await import('../src/${first}')
  expect(Object.keys(loaded)).toHaveLength(1)
})
`
}

function instancesProject(
  options: { include?: string; testConfig?: string } = {},
): string {
  return createProject({
    ...options,
    extraFiles: {
      '.gitignore':
        'node_modules\n.tia/\ncoverage/\nexecutions.log\nphase.txt\n',
      'driver.mjs': driver,
      'src/c.ts': "export const c = () => 'c'\n",
      'src/d.ts': "export const d = () => 'd'\n",
    },
    pluginOptions: '{ enabled: true, log: true }',
    testA: phasedTest('a', 'a', 'c'),
    // The slower of two instances commits second, onto a graph the first changed.
    testB: phasedTest('b', 'b', 'd', 1500),
  })
}

function drive(root: string, steps: Step[]): { output: string; waves: Wave[] } {
  const result = runCommand(
    root,
    process.execPath,
    ['driver.mjs', JSON.stringify(steps)],
    90_000,
  )
  expect(result.status, result.output).toBe(0)
  const line = result.output
    .split('\n')
    .find((candidate) => candidate.startsWith('RESULT '))
  expect(line, result.output).toBeDefined()
  return {
    output: result.output,
    waves: JSON.parse((line ?? '').slice('RESULT '.length)) as Wave[],
  }
}

afterEach(cleanupProjects)

describe('Vitest instances in one process', () => {
  test(
    'each records and replays from what the one before committed',
    { timeout: 120_000 },
    async () => {
      const root = instancesProject()

      const { waves } = drive(root, [
        { phase: 'one' },
        { wave: [{}] },
        { append: 'src/b.ts' },
        { wave: [{}] },
        { wave: [{}] },
      ])

      // The second instance replays a and runs b; the third finds nothing
      // changed because the second committed its own graph.
      expect(waves.map((wave) => wave.executions)).toEqual([
        ['a', 'b'],
        ['b'],
        [],
      ])
      expect(waves.flatMap((wave) => wave.instances)).toEqual([
        { failed: 0, reporters: 1 },
        { failed: 0, reporters: 1 },
        { failed: 0, reporters: 1 },
      ])
      const replay = runVitest(root, ['run'], 30_000, { TIA: '1' })
      expect(replay.status, replay.output).toBe(0)
      expect(executions(root).filter((name) => name !== '')).toEqual([])
    },
  )

  test(
    'two at once on one cache directory both commit',
    { timeout: 120_000 },
    async () => {
      const root = instancesProject()

      const { output, waves } = drive(root, [
        { phase: 'one' },
        { wave: [{}] },
        { phase: 'two' },
        { append: 'src/a.ts' },
        { append: 'src/b.ts' },
        {
          concurrent: true,
          wave: [
            { include: ['test/a.test.ts'] },
            { include: ['test/b.test.ts'] },
          ],
        },
      ])

      expect(waves[1]).toEqual({
        executions: ['a', 'b'],
        instances: [
          { failed: 0, reporters: 1 },
          { failed: 0, reporters: 1 },
        ],
      })
      expect(output).not.toContain('TIA graph was not updated')
      // Neither update was lost: each test's new dependency is stored.
      const graph = await readGraph(root)
      const dependencies = (testFile: string): string[] =>
        Object.values(graph.testEdges)
          .filter((edge) => edge.file === testFile)
          .flatMap((edge) => edge.files)
      expect(dependencies('test/a.test.ts')).toContain('src/c.ts')
      expect(dependencies('test/a.test.ts')).not.toContain('src/a.ts')
      expect(dependencies('test/b.test.ts')).toContain('src/d.ts')
      expect(dependencies('test/b.test.ts')).not.toContain('src/b.ts')
    },
  )

  test(
    'projects of one instance share a runtime and one reporter',
    { timeout: 120_000 },
    async () => {
      const root = instancesProject({
        include: '[]',
        testConfig: `projects: [
      { extends: true, test: { name: 'one', include: ['test/a.test.ts'] } },
      { extends: true, test: { name: 'two', include: ['test/b.test.ts'] } },
    ],`,
      })

      const { output, waves } = drive(root, [
        { phase: 'one' },
        { wave: [{}] },
        { append: 'src/a.ts' },
        { wave: [{}] },
      ])

      expect(waves.map((wave) => wave.executions)).toEqual([['a', 'b'], ['a']])
      expect(waves.flatMap((wave) => wave.instances)).toEqual([
        { failed: 0, reporters: 1 },
        { failed: 0, reporters: 1 },
      ])
      expect(output.match(/TIA graph saved/g)).toHaveLength(2)
      expect(output.match(/TIA recording full-suite baseline/g)).toHaveLength(1)
    },
  )
})

// The plugin hooks against stand-ins for Vitest, which is quick enough to try
// the orders Vitest's own start-up produces.

interface Hooks {
  config(config: Record<string, unknown>): void
  configureVitest(context: { project: unknown; vitest: unknown }): Promise<void>
  transform(
    this: unknown,
    code: string,
    id: string,
  ): { code: string } | undefined
}

interface FakeInstance {
  projects: unknown[]
  reporters: unknown[]
  vitest: unknown
}

let hookRoot = ''

function plugin(): Hooks {
  return tia({ cacheDir: '.tia', enabled: true, log: false }) as never
}

/** A Vitest stand-in with `count` projects over the temporary repository. */
function fakeInstance(count: number): FakeInstance {
  const coverage = { enabled: false, reportsDirectory: join(hookRoot, 'cov') }
  const projects = Array.from({ length: count }, () => ({
    config: {
      coverage,
      exclude: [] as string[],
      include: ['test/**/*.test.ts'],
      passWithNoTests: false,
      root: hookRoot,
    },
    globTestFiles: () =>
      Promise.resolve({ testFiles: [join(hookRoot, 'test/gen.test.ts')] }),
    provide: () => undefined,
    vite: { config: { configFile: undefined } },
  }))
  const reporters: unknown[] = []
  const vitest = {
    config: {
      coverage,
      reporters,
      root: hookRoot,
      sequence: { hooks: 'stack' },
      shard: undefined,
      watch: false,
    },
    disableCoverage: () => undefined,
    logger: {
      error: () => undefined,
      log: () => undefined,
      warn: () => undefined,
    },
    projects,
  }
  return { projects, reporters, vitest }
}

function runtimeOf(vitest: unknown): TiaRuntime {
  const holder = globalThis as typeof globalThis & Record<symbol, unknown>
  const states = holder[Symbol.for(`tiacore@${VERSION}/shared-state`)]
  if (!(states instanceof WeakMap)) throw new Error('no shared state registry')
  const shared = states.get(vitest as object) as
    | { runtime: TiaRuntime }
    | undefined
  if (shared === undefined) throw new Error('the instance was never configured')
  return shared.runtime
}

const transformContext = {
  getCombinedSourcemap: () => ({ mappings: '' }),
  warn: () => undefined,
}

/** The hash of the instrumentation `hooks` give src/gen.ts. */
function instrument(hooks: Hooks): string {
  const instrumented = hooks.transform.call(
    transformContext,
    'export const value = 1\n',
    join(hookRoot, 'src/gen.ts'),
  )
  const hash = instrumentationHash(instrumented?.code ?? '')
  if (hash === null) throw new Error('the file was not instrumented')
  return hash
}

function knows(runtime: TiaRuntime, hash: string): boolean {
  return (
    runtime.coverageTemplates.unknownFiles(hookRoot, {
      [join(hookRoot, 'src/gen.ts')]: { b: {}, f: {}, hash, s: {} },
    }).length === 0
  )
}

describe('the Vitest plugin hooks', () => {
  beforeAll(() => {
    hookRoot = mkdtempSync(join(tmpdir(), 'tiacore-instances-'))
    mkdirSync(join(hookRoot, 'src'))
    mkdirSync(join(hookRoot, 'test'))
    writeFileSync(join(hookRoot, 'package.json'), '{"type":"module"}\n')
    writeFileSync(join(hookRoot, '.gitignore'), '.tia/\n')
    writeFileSync(join(hookRoot, 'src/gen.ts'), 'export const value = 1\n')
    writeFileSync(
      join(hookRoot, 'test/gen.test.ts'),
      "import { value } from '../src/gen.ts'\nvalue\n",
    )
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'tia@example.test'],
      ['config', 'user.name', 'TIA'],
      ['add', '.'],
      ['commit', '-qm', 'baseline'],
    ]) {
      execFileSync('git', args, { cwd: hookRoot, stdio: 'ignore' })
    }
  })

  afterAll(async () => {
    await disposeHost()
    rmSync(hookRoot, { force: true, recursive: true })
  })

  test('projects configured at once register one reporter between them', async () => {
    const { projects, reporters, vitest } = fakeInstance(3)
    const hooks = projects.map(() => plugin())
    for (const one of hooks) one.config({ root: hookRoot })

    await Promise.all(
      hooks.map((one, index) =>
        one.configureVitest({ project: projects[index], vitest }),
      ),
    )

    expect(reporters).toHaveLength(1)
  })

  test('every instance gets its own reporter and its own plan', async () => {
    const first = fakeInstance(1)
    const second = fakeInstance(1)
    const [firstHooks, secondHooks] = [plugin(), plugin()]
    for (const one of [firstHooks, secondHooks]) one.config({ root: hookRoot })

    await firstHooks.configureVitest({
      project: first.projects[0],
      vitest: first.vitest,
    })
    const firstRun = runtimeOf(first.vitest).run
    await secondHooks.configureVitest({
      project: second.projects[0],
      vitest: second.vitest,
    })

    expect(first.reporters).toHaveLength(1)
    expect(second.reporters).toHaveLength(1)
    expect(second.reporters[0]).not.toBe(first.reporters[0])
    expect(runtimeOf(second.vitest)).not.toBe(runtimeOf(first.vitest))
    expect(runtimeOf(second.vitest).run).not.toBeNull()
    // Planning the second did not touch the first.
    expect(runtimeOf(first.vitest).run).toBe(firstRun)
  })

  test('instances configured at once transform into their own runtimes', async () => {
    const first = fakeInstance(1)
    const second = fakeInstance(1)
    const [firstHooks, secondHooks] = [plugin(), plugin()]
    for (const one of [firstHooks, secondHooks]) one.config({ root: hookRoot })

    await Promise.all([
      firstHooks.configureVitest({
        project: first.projects[0],
        vitest: first.vitest,
      }),
      secondHooks.configureVitest({
        project: second.projects[0],
        vitest: second.vitest,
      }),
    ])
    const hash = instrument(firstHooks)

    expect(knows(runtimeOf(first.vitest), hash)).toBe(true)
    expect(knows(runtimeOf(second.vitest), hash)).toBe(false)
  })

  test('a server started after the hooks transforms into the latest instance’s runtime', async () => {
    const first = fakeInstance(1)
    const second = fakeInstance(1)
    await plugin().configureVitest({
      project: first.projects[0],
      vitest: first.vitest,
    })
    await plugin().configureVitest({
      project: second.projects[0],
      vitest: second.vitest,
    })
    // Browser Mode loads the config again; this copy sees no configureVitest.
    const browserServer = plugin()
    browserServer.config({ root: hookRoot })

    const hash = instrument(browserServer)

    expect(knows(runtimeOf(second.vitest), hash)).toBe(true)
    expect(knows(runtimeOf(first.vitest), hash)).toBe(false)
  })
})
