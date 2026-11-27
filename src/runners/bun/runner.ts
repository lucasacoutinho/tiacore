import { resolve } from 'node:path'

import { CoreRun } from '../../engine/core-run.ts'
import { normalizedConcurrency } from '../../engine/scheduling.ts'
import {
  relativeTestFiles,
  resolveTestFiles,
  runKernel,
} from '../shared/run.ts'
import type {
  TiaRunner,
  TiaRunnerOptions,
  TiaRunnerResult,
} from '../shared/types.ts'
import {
  observeBunCachedCases,
  observeBunFiles,
  type BunContext,
} from './observe.ts'

const DEFAULT_BUN_TESTS = [
  'test/**/*.test.{js,jsx,ts,tsx}',
  '**/*.test.{js,jsx,ts,tsx}',
]

export interface TiaBunRunnerOptions extends TiaRunnerOptions {
  /** The bun executable. Defaults to the running Bun, else `bun` on PATH. */
  binary?: string
}

class BunTiaRunner implements TiaRunner {
  private readonly context: BunContext
  private readonly core: CoreRun
  private readonly files: string[]
  private readonly log: boolean
  private readonly root: string

  constructor(options: TiaBunRunnerOptions) {
    this.root = resolve(options.root ?? process.cwd())
    this.files = resolveTestFiles(this.root, options.files ?? DEFAULT_BUN_TESTS)
    this.log = options.log ?? true
    this.context = {
      binary:
        options.binary ??
        (process.versions.bun === undefined ? 'bun' : process.execPath),
      concurrency: normalizedConcurrency(options.concurrency),
      root: this.root,
    }
    const { binary: _binary, ...coreOptions } = options
    this.core = new CoreRun({
      ...coreOptions,
      files: options.files ?? DEFAULT_BUN_TESTS,
      fingerprint: 'bun-v2',
      root: this.root,
      runner: 'bun',
      testFiles: relativeTestFiles(this.root, this.files),
    })
  }

  async run(): Promise<TiaRunnerResult> {
    return await runKernel({
      core: this.core,
      files: this.files,
      label: 'bun',
      log: this.log,
      observeCachedCases: (results) =>
        observeBunCachedCases(this.context, results),
      observeFiles: (files) => observeBunFiles(this.context, files),
      root: this.root,
    })
  }
}

/**
 * A runner that records and replays `bun:test` suites per test case, including
 * cases inside nested `describe(...)` blocks. Skipped and todo cases cannot be
 * distinguished in Bun's JUnit output from cases excluded by a name filter, so
 * they stay fail-closed as a module failure of their file, as does any
 * selected case whose run fails outside it or does not report it.
 */
export function tia(options: TiaBunRunnerOptions = {}): TiaRunner {
  return new BunTiaRunner(options)
}

export type { TiaRunner, TiaRunnerOptions, TiaRunnerResult }
