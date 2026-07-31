import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  TiaImpactGraph,
  TiaSuiteDescriptor,
} from '../../protocol/types.js'
import { parseImpactGraph } from '../../protocol/validate.js'

export interface AdapterExecution {
  status: number
  suiteId: string
}

interface ExecuteSuitesOptions<Suite extends TiaSuiteDescriptor> {
  argumentsFor(suite: Suite): string[]
  command: string
  cwd: string
  environment?: NodeJS.ProcessEnv
  maxConcurrency: number
  suites: Suite[]
}

function executeCommand<Suite extends TiaSuiteDescriptor>(
  options: ExecuteSuitesOptions<Suite>,
  suite: Suite,
): Promise<AdapterExecution> {
  return new Promise((resolveExecution, reject) => {
    const child = spawn(
      options.command,
      options.argumentsFor(suite),
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.environment },
        stdio: 'inherit',
      },
    )
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolveExecution({
        status: code ?? (signal === null ? 1 : 128),
        suiteId: suite.id,
      })
    })
  })
}

export async function executeSuites<Suite extends TiaSuiteDescriptor>(
  options: ExecuteSuitesOptions<Suite>,
): Promise<AdapterExecution[]> {
  if (
    !Number.isSafeInteger(options.maxConcurrency) ||
    options.maxConcurrency < 1
  ) {
    throw new Error('TIA adapter maxConcurrency must be a positive integer')
  }

  const pending = [...options.suites]
  const activeLocks = new Set<string>()
  const running = new Set<Promise<void>>()
  const executions: AdapterExecution[] = []

  const launch = (suite: Suite): void => {
    const locks = suite.resourceLocks ?? []
    for (const lock of locks) activeLocks.add(lock)
    let task: Promise<void>
    task = executeCommand(options, suite)
      .then((execution) => {
        executions.push(execution)
      })
      .finally(() => {
        for (const lock of locks) activeLocks.delete(lock)
        running.delete(task)
      })
    running.add(task)
  }

  while (pending.length > 0 || running.size > 0) {
    let launched = false
    while (running.size < options.maxConcurrency) {
      const index = pending.findIndex((suite) =>
        (suite.resourceLocks ?? []).every((lock) => !activeLocks.has(lock)),
      )
      if (index < 0) break
      const [suite] = pending.splice(index, 1)
      if (suite === undefined) break
      launch(suite)
      launched = true
    }
    if (running.size > 0 && (!launched || running.size >= options.maxConcurrency)) {
      await Promise.race(running)
    }
  }

  return executions.sort((left, right) =>
    left.suiteId.localeCompare(right.suiteId),
  )
}

export async function readAdapterGraph(
  path: string,
): Promise<TiaImpactGraph | null> {
  try {
    return parseImpactGraph(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

export async function writeAdapterGraph(
  path: string,
  graph: TiaImpactGraph,
): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
