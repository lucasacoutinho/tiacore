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
import { nodeHelperPath } from './assets.ts'
import { nodeVersionSupported } from './discovery.ts'
import {
  observeNodeCachedCases,
  observeNodeFiles,
  type NodeContext,
  type NodeHelpers,
} from './observe.ts'
import { canonicalNodePath } from './paths.ts'

const DEFAULT_NODE_TESTS = [
  'test/**/*.test.{js,cjs,mjs,ts,cts,mts}',
  'test-*.{js,cjs,mjs,ts,cts,mts}',
  '**/*.test.{js,cjs,mjs,ts,cts,mts}',
]

function helpers(): NodeHelpers {
  const register = nodeHelperPath('discovery-register.js')
  const execution = nodeHelperPath('execution-child.js')
  if (register === null || execution === null) {
    throw new Error(
      'TIA node runner helper scripts are missing; reinstall @lucasacoutinho/tiacore',
    )
  }
  return { execution, register }
}

class NodeTiaRunner implements TiaRunner {
  private readonly concurrency: number
  private readonly core: TiaCore
  private readonly files: string[]
  private readonly log: boolean
  private readonly root: string

  constructor(options: TiaRunnerOptions) {
    this.root = canonicalNodePath(options.root ?? process.cwd())
    this.concurrency = normalizedConcurrency(options.concurrency)
    this.files = resolveTestFiles(
      this.root,
      options.files ?? DEFAULT_NODE_TESTS,
    )
    this.log = options.log ?? true
    this.core = new TiaCore({
      ...options,
      files: options.files ?? DEFAULT_NODE_TESTS,
      root: this.root,
      runner: 'node',
      testFiles: relativeTestFiles(this.root, this.files),
    })
  }

  async run(): Promise<TiaRunnerResult> {
    if (!nodeVersionSupported()) {
      throw new Error(
        '@lucasacoutinho/tiacore/node requires Node.js 22.10 or newer for programmatic test coverage',
      )
    }
    const context: NodeContext = {
      concurrency: this.concurrency,
      helpers: helpers(),
      log: this.log,
      root: this.root,
    }
    return await runKernel({
      core: this.core,
      files: this.files,
      label: 'node',
      log: this.log,
      observeCachedCases: (results) => observeNodeCachedCases(context, results),
      observeFiles: (files) => observeNodeFiles(context, files),
      root: this.root,
    })
  }
}

/** A runner that records and replays `node:test` suites per test case. */
export function tia(options: TiaRunnerOptions = {}): TiaRunner {
  return new NodeTiaRunner(options)
}

export type { TiaRunner, TiaRunnerOptions, TiaRunnerResult }
