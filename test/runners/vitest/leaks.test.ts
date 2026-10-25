import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { VERSION } from '../../../src/core/version.ts'
import { instrumentationHash } from '../../../src/engine/coverage/templates.ts'
import { tia } from '../../../src/runners/vitest/plugin.ts'
import {
  TIA_META_KEY,
  TIA_TEST_META_KEY,
} from '../../../src/runners/vitest/protocol.ts'
import { TiaReporter } from '../../../src/runners/vitest/reporter.ts'
import type { TiaRuntime } from '../../../src/runners/vitest/state.ts'
import { disposeHost } from '../../../src/host/runtime.ts'
import { assertNoLeak } from '../../support/leak.ts'

// NF-MEM: the Vitest plugin and reporter keep per-run state in a runtime that
// outlives one Vitest instance (browser-mode servers share it), so a process
// that starts Vitest again and again must not keep one run's state for the next.

interface Hooks {
  config(config: Record<string, unknown>): void
  configureVitest(context: { project: unknown; vitest: unknown }): Promise<void>
  transform(
    this: unknown,
    code: string,
    id: string,
  ): { code: string } | undefined
}

interface ReporterHooks {
  onInit(vitest: unknown): void
  onTestCaseResult(testCase: unknown): void
  onTestModuleEnd(module: unknown): void
  onTestRunEnd(
    modules: unknown[],
    errors: unknown[],
    reason: 'passed',
  ): Promise<void>
  onTestRunStart(): Promise<void>
}

let root = ''

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tiacore-vitest-leak-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, '.gitignore'), '.tia/\n')
  writeFileSync(join(root, 'src/gen.ts'), 'export const value = 1\n')
  writeFileSync(
    join(root, 'test/gen.test.ts'),
    "import { value } from '../src/gen.ts'\nvalue\n",
  )
  git('init', '-q')
  git('config', 'user.email', 'tia@example.test')
  git('config', 'user.name', 'TIA')
  git('add', '.')
  git('commit', '-qm', 'baseline')
})

afterAll(async () => {
  await disposeHost()
  rmSync(root, { force: true, recursive: true })
})

function fakeVitest(watch: boolean) {
  const logger = {
    error: () => undefined,
    log: () => undefined,
    warn: () => undefined,
  }
  const project = {
    config: {
      coverage: { enabled: false, reportsDirectory: join(root, 'coverage') },
      exclude: [] as string[],
      include: ['test/**/*.test.ts'],
      passWithNoTests: false,
      root,
    },
    globTestFiles: () =>
      Promise.resolve({ testFiles: [join(root, 'test/gen.test.ts')] }),
    provide: () => undefined,
    vite: { config: { configFile: undefined } },
  }
  const reporters: unknown[] = []
  const vitest = {
    config: {
      coverage: project.config.coverage,
      reporters,
      root,
      sequence: { hooks: 'stack' },
      shard: undefined,
      watch,
    },
    disableCoverage: () => undefined,
    logger,
    projects: [project],
  }
  return { project, reporters, vitest }
}

/** Source whose instrumentation differs for every `version`, like a file edited between runs. */
function source(version: number): string {
  const functions = Array.from(
    { length: 150 },
    (_, index) => `export function f${index}() { return ${version + index} }`,
  )
  return `${functions.join('\n')}\n`
}

const transformContext = {
  getCombinedSourcemap: () => ({ mappings: '' }),
  warn: () => undefined,
}

function runtimes(): Map<string, TiaRuntime> {
  const holder = globalThis as typeof globalThis & Record<symbol, unknown>
  const registry =
    holder[Symbol.for(`tiacore@${VERSION}/browser-runtime-state`)]
  if (!(registry instanceof Map)) throw new Error('no runtime registry')
  return registry as Map<string, TiaRuntime>
}

const options = { cacheDir: '.tia', enabled: true, log: false }

describe('the Vitest plugin', () => {
  test('bypassed watch starts keep one runtime and retain nothing', async () => {
    const result = await assertNoLeak(
      async () => {
        const hooks = tia(options) as unknown as Hooks
        const { project, vitest } = fakeVitest(true)
        hooks.config({ root })
        await hooks.configureVitest({ project, vitest })
      },
      { bytesPerOperation: 4_096, iterations: 40 },
    )
    expect(result.bytesPerOperation).toBeLessThan(4_096)
    expect(
      [...runtimes().keys()].filter((key) => key.startsWith(root)),
    ).toHaveLength(1)
  })

  test('a new run starts without the previous run’s instrumentation templates', async () => {
    let version = 0
    let stale: { hash: string; path: string } | undefined
    const result = await assertNoLeak(
      async () => {
        version += 1
        const hooks = tia(options) as unknown as Hooks
        const { project, vitest } = fakeVitest(false)
        hooks.config({ root })
        await hooks.configureVitest({ project, vitest })
        const transformed = hooks.transform.call(
          transformContext,
          source(version),
          join(root, 'src/gen.ts'),
        )
        const hash = instrumentationHash(transformed?.code ?? '')
        if (hash === null) throw new Error('the file was not instrumented')
        stale ??= { hash, path: join(root, 'src/gen.ts') }
      },
      // A template for 150 functions weighs over 100 kilobytes, so keeping one
      // per run would show here; the limit leaves room for Babel's one-time
      // warm-up growth.
      { batches: 3, bytesPerOperation: 32_768, iterations: 30 },
    )
    expect(result.bytesPerOperation).toBeLessThan(32_768)
    const runtime = [...runtimes().entries()].find(([key]) =>
      key.startsWith(root),
    )?.[1]
    expect(runtime).toBeDefined()
    // The first run's template is gone: its counters would be reported unknown.
    expect(
      runtime?.coverageTemplates.unknownFiles(root, {
        [stale?.path ?? '']: { b: {}, f: {}, hash: stale?.hash ?? '', s: {} },
      }),
    ).toEqual([join(root, 'src/gen.ts')])
  }, 120_000)
})

describe('the Vitest reporter', () => {
  test('whole runs, from configuration to commit, retain nothing', async () => {
    let version = 0
    let testCasesSeen = 0
    const result = await assertNoLeak(
      async () => {
        version += 1
        const hooks = tia(options) as unknown as Hooks
        const { project, reporters, vitest } = fakeVitest(false)
        hooks.config({ root })
        await hooks.configureVitest({ project, vitest })
        const transformed = hooks.transform.call(
          transformContext,
          source(version),
          join(root, 'src/gen.ts'),
        )
        const hash = instrumentationHash(transformed?.code ?? '')
        // Vitest gives the reporter to the first instance of a runtime only.
        const runtime = [...runtimes().entries()].find(([key]) =>
          key.startsWith(root),
        )?.[1]
        if (runtime === undefined) throw new Error('no runtime')
        const reporter: ReporterHooks = new TiaReporter(runtime) as never
        expect(reporters.length).toBeLessThanOrEqual(1)
        reporter.onInit(vitest)
        await reporter.onTestRunStart()
        const file = join(root, 'test/gen.test.ts')
        const module = {
          moduleId: file,
          meta: () => ({
            [TIA_META_KEY]: {
              collectionCoverage: {},
              collectionFiles: [],
              concurrent: false,
              files: [join(root, 'src/gen.ts')],
            },
          }),
          ok: () => true,
          state: () => 'passed',
        }
        const taskMeta: Record<string, unknown> = {
          [TIA_TEST_META_KEY]: {
            coverage: {
              [join(root, 'src/gen.ts')]: {
                b: {},
                f: { '0': 1 },
                hash,
                s: {},
              },
            },
            files: [join(root, 'src/gen.ts')],
          },
        }
        reporter.onTestCaseResult({
          diagnostic: () => ({ duration: 1 }),
          fullName: 'gen works',
          id: 'gen-1',
          meta: () => taskMeta,
          module,
          result: () => ({ state: 'passed' }),
        })
        // The reporter takes the payload off the task: it is not kept twice.
        expect(taskMeta[TIA_TEST_META_KEY]).toBeUndefined()
        testCasesSeen += 1
        reporter.onTestModuleEnd(module)
        await reporter.onTestRunEnd([module], [], 'passed')
      },
      { bytesPerOperation: 24_576, iterations: 10 },
    )
    expect(testCasesSeen).toBeGreaterThan(0)
    expect(result.bytesPerOperation).toBeLessThan(24_576)
  }, 180_000)
})
