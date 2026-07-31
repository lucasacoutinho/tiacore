import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { globSync } from 'tinyglobby'

import { TiaCore, type TiaObservation } from '../../engine/run.js'
import {
  groupBy,
  normalizedConcurrency,
  parallelMap,
} from '../../engine/scheduling/parallel.js'
import {
  fullyExecutedFiles,
  moduleFailureObservation,
} from '../../engine/observations.js'
import { slash } from '../../shared/paths.js'
import type {
  TiaRunner,
  TiaRunnerOptions,
  TiaRunnerResult,
} from '../../engine/runner.js'
import {
  nodeDiscoveryHooksSupported,
  parseNodeDiscoveryRecords,
  type NodeCase,
  type NodeDiscovery,
  type NodeExecution,
} from './discovery.js'

function runnerAsset(name: string): string {
  const moduleAsset = fileURLToPath(new URL(`./${name}`, import.meta.url))
  if (existsSync(moduleAsset)) {
    return moduleAsset
  }

  return fileURLToPath(new URL(`./adapters/node/${name}`, import.meta.url))
}

const DEFAULT_NODE_TESTS = [
  'test/**/*.test.{js,cjs,mjs,ts,cts,mts}',
  'test-*.{js,cjs,mjs,ts,cts,mts}',
  '**/*.test.{js,cjs,mjs,ts,cts,mts}',
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nodeVersionSupported(): boolean {
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .map(Number)
  return major > 22 || (major === 22 && minor >= 10)
}

class NodeTiaRunner implements TiaRunner {
  private readonly core: TiaCore
  private readonly concurrency: number
  private readonly files: string[]
  private readonly log: boolean
  private readonly root: string
  private readonly discoveryRegister = runnerAsset(
    'discovery-register.js',
  )
  private readonly executionChild = runnerAsset('execution-child.js')

  constructor(options: TiaRunnerOptions) {
    this.root = resolve(options.root ?? process.cwd())
    this.concurrency = normalizedConcurrency(options.concurrency)
    this.files = this.resolveFiles(options.files ?? DEFAULT_NODE_TESTS)
    this.log = options.log ?? true
    this.core = new TiaCore({
      ...options,
      files: options.files ?? DEFAULT_NODE_TESTS,
      root: this.root,
      runner: 'node',
      testFiles: this.files.map((file) =>
        slash(relative(this.root, file)),
      ),
    })
  }

  async run(): Promise<TiaRunnerResult> {
    if (!nodeVersionSupported()) {
      throw new Error(
        '@usescherie/tiacore/node requires Node.js 22.10 or newer for programmatic test coverage',
      )
    }

    const plan = await this.core.prepare()
    this.print(
      plan.mode === 'record'
        ? `TIA node recording full-suite baseline (${plan.reason}).`
        : `TIA node replay: ${plan.reason}; ${plan.replayedTests} cached test result${
            plan.replayedTests === 1 ? '' : 's'
          }.`,
    )

    const observations: TiaObservation[] = []
    const wholeFiles =
      plan.mode === 'record'
        ? this.files.map((file) => slash(relative(this.root, file)))
        : plan.wholeTestFiles

    if (plan.mode === 'record') {
      observations.push(...(await this.observeFiles(this.files)))
    } else {
      observations.push(
        ...(await this.observeFiles(
          plan.wholeTestFiles.map((file) => resolve(this.root, file)),
        )),
      )
      const cached = plan.affectedTestIds.flatMap((id) => {
        const result = plan.graph?.results[id]
        return result === undefined ? [] : [result]
      })
      observations.push(...(await this.observeCachedCases(cached)))
    }

    const graph = await this.core.commit(
      observations,
      fullyExecutedFiles(plan, observations, wholeFiles),
    )
    const success = observations.every(
      (observation) => observation.state !== 'failed',
    )
    this.print(
      `TIA node complete: ${observations.length} executed, ${plan.replayedTests} replayed.`,
    )

    return {
      executedTests: observations,
      graphSaved: graph !== null,
      plan,
      replayedTests: plan.replayedTests,
      success,
    }
  }

  private async observeFiles(files: string[]): Promise<TiaObservation[]> {
    if (files.length === 0) {
      return []
    }

    const discovery = await this.discover(files)
    const observations: TiaObservation[] = []

    if (discovery.aggregate) {
      return discovery.cases.map((testCase) =>
        this.observation(testCase, [
          testCase.file,
          ...discovery.coverageFiles,
        ]),
      )
    }

    const groups = groupBy(
      discovery.cases,
      (candidate) => candidate.file,
    )
    observations.push(
      ...(
        await parallelMap(
          [...groups.values()],
          this.concurrency,
          async (candidates) => {
            const fileObservations: TiaObservation[] = []
            for (const candidate of candidates) {
              if (candidate.state === 'skipped') {
                fileObservations.push(
                  this.observation(candidate, [candidate.file]),
                )
                continue
              }

              const execution = await this.execute(
                [resolve(this.root, candidate.file)],
                new RegExp(`^${escapeRegExp(candidate.fullName)}$`),
                true,
              )
              const executed = execution.cases.find(
                (item) =>
                  item.id === candidate.id ||
                  item.fullName === candidate.fullName ||
                  item.fullName === candidate.name ||
                  candidate.fullName.endsWith(` ${item.fullName}`),
              )
              const result =
                executed === undefined
                  ? {
                      ...candidate,
                      state: 'failed' as const,
                    }
                  : {
                      ...executed,
                      column: candidate.column,
                      file: candidate.file,
                      fullName: candidate.fullName,
                      id: candidate.id,
                      line: candidate.line,
                    }
              fileObservations.push(
                this.observation(result, [
                  candidate.file,
                  ...execution.coverageFiles,
                ]),
              )
            }
            return fileObservations
          },
        )
      ).flat(),
    )

    const observedFiles = new Set(observations.map((item) => item.file))
    for (const file of discovery.moduleFailures) {
      if (!observedFiles.has(file)) {
        observations.push(moduleFailureObservation(file))
      }
    }

    return observations
  }

  private async observeCachedCases(
    cached: NonNullable<ReturnType<TiaCore['replayedResults']>[number]>[],
  ): Promise<TiaObservation[]> {
    const groups = groupBy(cached, (result) => result.file)
    return (
      await parallelMap(
        [...groups.values()],
        this.concurrency,
        async (results) => {
          const observations: TiaObservation[] = []
          for (const result of results) {
            observations.push(...(await this.observeCachedCase(result)))
          }
          return observations
        },
      )
    ).flat()
  }

  private async observeCachedCase(
    cached: NonNullable<ReturnType<TiaCore['replayedResults']>[number]>,
  ): Promise<TiaObservation[]> {
    const moduleFailure = cached.id === `module:${cached.file}`
    const execution = await this.execute(
      [resolve(this.root, cached.file)],
      moduleFailure
        ? undefined
        : new RegExp(`^${escapeRegExp(cached.fullName)}$`),
      true,
    )
    if (moduleFailure && execution.cases.length > 0) {
      return execution.cases.map((testCase) =>
        this.observation(testCase, [
          cached.file,
          ...execution.coverageFiles,
        ]),
      )
    }
    const executed = execution.cases.find(
      (item) =>
        item.id === cached.id ||
        item.fullName === cached.fullName ||
        cached.fullName.endsWith(` ${item.fullName}`),
    )
    const result =
      executed === undefined
        ? undefined
        : {
            ...executed,
            fullName: cached.fullName,
            id: cached.id,
          }
    if (result !== undefined) {
      return [
        this.observation(result, [
          cached.file,
          ...execution.coverageFiles,
        ]),
      ]
    }

    if (execution.moduleFailures.length > 0) {
      return execution.moduleFailures.map(moduleFailureObservation)
    }

    return []
  }

  private observation(
    testCase: NodeCase,
    files: string[],
  ): TiaObservation {
    return {
      ...(testCase.duration === undefined
        ? {}
        : { duration: testCase.duration }),
      file: testCase.file,
      files: [...new Set(files)].sort(),
      fullName: testCase.fullName,
      id: testCase.id,
      state: testCase.state,
    }
  }

  private async discover(files: string[]): Promise<NodeDiscovery> {
    if (!nodeDiscoveryHooksSupported()) {
      const aggregate = await this.execute(files, undefined, true)
      return { ...aggregate, aggregate: true }
    }

    const temporary = mkdtempSync(join(tmpdir(), 'tiacore-node-discovery-'))
    const output = join(temporary, 'cases.jsonl')
    writeFileSync(output, '')

    try {
      const moduleFailures = (
        await parallelMap(
          files,
          this.concurrency,
          async (file) =>
            await this.discoverFile(file, output),
        )
      ).filter((file): file is string => file !== null)
      const cases = parseNodeDiscoveryRecords(
        this.root,
        readFileSync(output, 'utf8'),
      )

      if (cases.length === 0 && moduleFailures.length === 0) {
        const aggregate = await this.execute(files, undefined, true)
        return { ...aggregate, aggregate: true }
      }

      return {
        aggregate: false,
        cases,
        coverageFiles: [],
        moduleFailures,
        success: moduleFailures.length === 0,
      }
    } finally {
      rmSync(temporary, { force: true, recursive: true })
    }
  }

  private async discoverFile(
    file: string,
    output: string,
  ): Promise<string | null> {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      TIACORE_NODE_DISCOVERY_FILE: output,
    }
    delete environment.NODE_TEST_CONTEXT

    const status = await new Promise<number | null>((resolveStatus) => {
      const child = spawn(
        process.execPath,
        ['--import', this.discoveryRegister, file],
        {
          cwd: this.root,
          env: environment,
          stdio: 'ignore',
        },
      )
      child.on('error', () => {
        resolveStatus(null)
      })
      child.on('close', resolveStatus)
    })

    return status === 0
      ? null
      : slash(relative(this.root, file))
  }

  private async execute(
    files: string[],
    pattern: RegExp | undefined,
    coverage: boolean,
  ): Promise<NodeExecution> {
    const temporary = mkdtempSync(join(tmpdir(), 'tiacore-node-execution-'))
    const request = join(temporary, 'request.json')
    const output = join(temporary, 'result.json')
    writeFileSync(
      request,
      JSON.stringify({
        coverage,
        files,
        ...(pattern === undefined
          ? {}
          : {
              pattern: {
                flags: pattern.flags,
                source: pattern.source,
              },
            }),
        root: this.root,
      }),
    )
    const environment: NodeJS.ProcessEnv = { ...process.env }
    delete environment.NODE_TEST_CONTEXT

    try {
      await new Promise<void>((resolveChild, rejectChild) => {
        const child = spawn(
          process.execPath,
          [this.executionChild, request, output],
          {
            cwd: this.root,
            env: environment,
            stdio: 'ignore',
            timeout: 30_000,
          },
        )
        child.on('error', rejectChild)
        child.on('close', () => {
          resolveChild()
        })
      })

      return JSON.parse(readFileSync(output, 'utf8')) as NodeExecution
    } catch {
      return {
        cases: [],
        coverageFiles: [],
        moduleFailures: files.map((file) =>
          slash(relative(this.root, file)),
        ),
        success: false,
      }
    } finally {
      rmSync(temporary, { force: true, recursive: true })
    }
  }

  private resolveFiles(patterns: string[]): string[] {
    return [
      ...new Set(
        patterns.flatMap((pattern) =>
          globSync(pattern, {
            cwd: this.root,
            ignore: ['**/node_modules/**', '**/.tia/**'],
          }).map((file) => resolve(this.root, file)),
        ),
      ),
    ].sort()
  }

  private print(message: string): void {
    if (this.log) {
      console.log(message)
    }
  }
}

export function tia(options: TiaRunnerOptions = {}): TiaRunner {
  return new NodeTiaRunner(options)
}

export type {
  TiaRunner,
  TiaRunnerOptions,
  TiaRunnerResult,
} from '../../engine/runner.js'
