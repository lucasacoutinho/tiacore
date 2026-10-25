import { resolve } from 'node:path'

import { TiaCore } from '../../engine/core.ts'
import { normalizedConcurrency } from '../shared/concurrency.ts'
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
  private readonly core: TiaCore
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
    this.core = new TiaCore({
      ...coreOptions,
      files: options.files ?? DEFAULT_BUN_TESTS,
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
 * A runner that records and replays `bun:test` suites per test case. A case
 * declared inside `describe(...)`, and any `test.skip` or `test.todo` case,
 * cannot be re-run on its own: Bun reports the leaf name but matches
 * `--test-name-pattern` against the full "<describe> <name>", and skipped
 * tests never match. Such a case is recorded as a failed module failure of its
 * file, so the file reruns whole.
 */
export function tia(options: TiaBunRunnerOptions = {}): TiaRunner {
  return new BunTiaRunner(options)
}

export type { TiaRunner, TiaRunnerOptions, TiaRunnerResult }
