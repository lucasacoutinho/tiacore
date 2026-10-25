import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { globSync } from 'tinyglobby'

import { TiaCore, type TiaObservation } from '../../engine/run.js'
import { formatRunPlanDetails } from '../../engine/explain.js'
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
import { parseBunJunit, parseBunLcov, type BunCase } from './report.js'
import type {
  TiaRunner,
  TiaRunnerOptions,
  TiaRunnerResult,
} from '../../engine/runner.js'

interface BunExecution {
  cases: BunCase[]
  coverageFiles: string[]
  output: string
  success: boolean
}

const DEFAULT_BUN_TESTS = [
  'test/**/*.test.{js,jsx,ts,tsx}',
  '**/*.test.{js,jsx,ts,tsx}',
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

class BunTiaRunner implements TiaRunner {
  private readonly binary: string
  private readonly concurrency: number
  private readonly core: TiaCore
  private readonly files: string[]
  private readonly log: boolean
  private readonly root: string

  constructor(options: TiaRunnerOptions & { binary?: string }) {
    this.root = resolve(options.root ?? process.cwd())
    this.concurrency = normalizedConcurrency(options.concurrency)
    this.files = this.resolveFiles(options.files ?? DEFAULT_BUN_TESTS)
    this.log = options.log ?? true
    this.binary =
      options.binary ??
      (process.versions.bun === undefined ? 'bun' : process.execPath)
    this.core = new TiaCore({
      ...options,
      files: options.files ?? DEFAULT_BUN_TESTS,
      root: this.root,
      runner: 'bun',
      testFiles: this.files.map((file) => slash(relative(this.root, file))),
    })
  }

  async run(): Promise<TiaRunnerResult> {
    const plan = await this.core.prepare()
    this.print(
      plan.mode === 'record'
        ? `TIA bun recording full-suite baseline (${plan.reason}).`
        : `TIA bun replay: ${plan.reason}; ${plan.replayedTests} cached test result${
            plan.replayedTests === 1 ? '' : 's'
          }.`,
    )
    for (const line of formatRunPlanDetails(plan)) {
      this.print(line)
    }

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
      `TIA bun complete: ${observations.length} executed, ${plan.replayedTests} replayed.`,
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

    const discoveries = await parallelMap(
      files,
      this.concurrency,
      async (file) => ({
        execution: await this.execute([file], 'a^', false),
        file: slash(relative(this.root, file)),
      }),
    )
    const discoveredCases: BunCase[] = []
    const observations: TiaObservation[] = []

    for (const discovery of discoveries) {
      if (
        !discovery.execution.success &&
        !(
          discovery.execution.cases.length > 0 &&
          discovery.execution.output.includes('matched 0 tests')
        )
      ) {
        observations.push(moduleFailureObservation(discovery.file))
      } else {
        discoveredCases.push(...discovery.execution.cases)
      }
    }

    const groups = groupBy(discoveredCases, (candidate) => candidate.file)
    observations.push(
      ...(
        await parallelMap(
          [...groups.values()],
          this.concurrency,
          async (candidates) => {
            const fileObservations: TiaObservation[] = []
            for (const candidate of candidates) {
              const execution = await this.execute(
                [resolve(this.root, candidate.file)],
                `^${escapeRegExp(candidate.fullName)}$`,
                true,
              )
              const result = execution.cases.find(
                (item) =>
                  item.id === candidate.id ||
                  item.fullName === candidate.fullName,
              )
              if (
                !execution.success &&
                (result === undefined || result.state !== 'failed')
              ) {
                fileObservations.push(moduleFailureObservation(candidate.file))
              } else {
                fileObservations.push(
                  this.observation(
                    result ?? { ...candidate, state: 'failed' },
                    [candidate.file, ...execution.coverageFiles],
                  ),
                )
              }
            }
            return fileObservations
          },
        )
      ).flat(),
    )

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
    const execution = await this.execute(
      [resolve(this.root, cached.file)],
      `^${escapeRegExp(cached.fullName)}$`,
      true,
    )
    const result = execution.cases.find(
      (item) => item.id === cached.id || item.fullName === cached.fullName,
    )
    if (
      result !== undefined &&
      (execution.success || result.state === 'failed')
    ) {
      return [
        this.observation(result, [cached.file, ...execution.coverageFiles]),
      ]
    }

    if (!execution.success) {
      return [moduleFailureObservation(cached.file)]
    }

    return []
  }

  private observation(testCase: BunCase, files: string[]): TiaObservation {
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

  private async execute(
    files: string[],
    pattern: string,
    coverage: boolean,
  ): Promise<BunExecution> {
    const temporary = mkdtempSync(join(tmpdir(), 'tiacore-bun-run-'))
    const junitPath = join(temporary, 'results.xml')
    const args = [
      'test',
      `--test-name-pattern=${pattern}`,
      '--reporter=junit',
      `--reporter-outfile=${junitPath}`,
      ...(coverage
        ? [
            '--coverage',
            '--coverage-reporter=lcov',
            `--coverage-dir=${temporary}`,
          ]
        : []),
      ...files,
    ]

    try {
      const result = await new Promise<{
        output: string
        status: number | null
      }>((resolveResult, reject) => {
        const child = spawn(this.binary, args, {
          cwd: this.root,
          env: { ...process.env, NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        })
        let output = ''
        child.stdout.on('data', (value) => {
          output += String(value)
        })
        child.stderr.on('data', (value) => {
          output += String(value)
        })
        child.on('error', reject)
        child.on('close', (status) => {
          resolveResult({ output, status })
        })
      })
      const xml = readFileSync(junitPath, 'utf8')
      const cases = parseBunJunit(this.root, xml)
      const coverageFiles = coverage
        ? parseBunLcov(
            this.root,
            readFileSync(join(temporary, 'lcov.info'), 'utf8'),
          )
        : []

      return {
        cases,
        coverageFiles,
        output: result.output,
        success: result.status === 0,
      }
    } catch (error) {
      return {
        cases: [],
        coverageFiles: [],
        output: error instanceof Error ? error.message : String(error),
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

export function tia(
  options: TiaRunnerOptions & { binary?: string } = {},
): TiaRunner {
  return new BunTiaRunner(options)
}

export type {
  TiaRunner,
  TiaRunnerOptions,
  TiaRunnerResult,
} from '../../engine/runner.js'
