import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { globSync } from 'tinyglobby'

import { TiaCore, type TiaObservation } from './core.js'
import {
  groupBy,
  normalizedConcurrency,
  parallelMap,
} from './parallel.js'
import {
  fullyExecutedFiles,
  moduleFailureObservation,
} from './observations.js'
import { isInside, slash } from '../shared/paths.js'
import type {
  TiaRunner,
  TiaRunnerOptions,
  TiaRunnerResult,
} from './types.js'

interface BunCase {
  duration?: number
  file: string
  fullName: string
  id: string
  line: number
  state: 'failed' | 'passed' | 'skipped'
}

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

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function attribute(source: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(source)
  return match === null ? null : decodeXml(match[1] ?? '')
}

function bunTestId(file: string, line: number, name: string): string {
  return `${file}:${line}:${name}`
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

    const groups = groupBy(
      discoveredCases,
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
            const execution = await this.execute(
              [resolve(this.root, candidate.file)],
              `^${escapeRegExp(candidate.fullName)}$`,
              true,
            )
            const result =
              execution.cases.find(
                (item) =>
                  item.id === candidate.id ||
                  item.fullName === candidate.fullName,
              )
            if (
              !execution.success &&
              (result === undefined || result.state !== 'failed')
            ) {
              fileObservations.push(
                moduleFailureObservation(candidate.file),
              )
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
      (item) =>
        item.id === cached.id ||
        item.fullName === cached.fullName,
    )
    if (
      result !== undefined &&
      (execution.success || result.state === 'failed')
    ) {
      return [
        this.observation(result, [
          cached.file,
          ...execution.coverageFiles,
        ]),
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
      const cases = this.parseJunit(xml)
      const coverageFiles = coverage
        ? this.parseLcov(readFileSync(join(temporary, 'lcov.info'), 'utf8'))
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

  private parseJunit(xml: string): BunCase[] {
    const cases: BunCase[] = []
    const expression =
      /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g

    for (const match of xml.matchAll(expression)) {
      const attributes = match[1] ?? ''
      const body = match[2] ?? ''
      const name = attribute(attributes, 'name')
      const sourceFile = attribute(attributes, 'file')
      if (name === null || sourceFile === null) {
        continue
      }

      const absoluteFile = resolve(this.root, sourceFile)
      if (!isInside(this.root, absoluteFile)) {
        continue
      }
      const file = slash(relative(this.root, absoluteFile))
      const line = Number(attribute(attributes, 'line') ?? 1)
      const duration = Number(attribute(attributes, 'time') ?? 0) * 1_000
      cases.push({
        ...(Number.isFinite(duration) ? { duration } : {}),
        file,
        fullName: name,
        id: bunTestId(file, line, name),
        line,
        state: body.includes('<failure')
          ? 'failed'
          : body.includes('<skipped')
            ? 'skipped'
            : 'passed',
      })
    }

    return cases
  }

  private parseLcov(lcov: string): string[] {
    const files = new Set<string>()

    for (const record of lcov.split('end_of_record')) {
      const source = /^SF:(.+)$/m.exec(record)?.[1]
      const covered = [...record.matchAll(/^DA:\d+,(\d+)/gm)].some(
        (match) => Number(match[1]) > 0,
      )
      if (source === undefined || !covered) {
        continue
      }

      const absoluteFile = resolve(this.root, source)
      if (isInside(this.root, absoluteFile)) {
        files.add(slash(relative(this.root, absoluteFile)))
      }
    }

    return [...files].sort()
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
} from './types.js'
