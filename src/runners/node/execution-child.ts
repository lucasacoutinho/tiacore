import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { run as runNodeTests } from 'node:test'

import { isObject } from '../shared/json.ts'

import { byCodeUnit } from '../../core/canonical.ts'
import { isInside, slash } from '../../engine/host-path.ts'
import { readNodeV8CoverageFiles } from './coverage.ts'
import { nodeTestId, type NodeCase, type NodeExecution } from './discovery.ts'
import { canonicalNodePath } from './paths.ts'

// Runs node:test over some files in this child and writes what happened as
// JSON: the parent spawns `node execution-child.js <request> <result>`. This
// module is an esbuild entry point and is the only code that runs the tests.

interface NodeExecutionRequest {
  readonly coverage: boolean
  readonly coverageDirectory?: string
  readonly files: readonly string[]
  readonly pattern?: { readonly flags: string; readonly source: string }
  readonly root: string
}

function parseRequest(source: string): NodeExecutionRequest {
  const value: unknown = JSON.parse(source)
  if (!isObject(value)) throw new Error('Invalid Node execution request')
  const { coverage, coverageDirectory, files, pattern, root } = value
  if (
    typeof coverage !== 'boolean' ||
    typeof root !== 'string' ||
    !Array.isArray(files) ||
    !files.every((file): file is string => typeof file === 'string')
  ) {
    throw new Error('Invalid Node execution request')
  }
  return {
    coverage,
    ...(typeof coverageDirectory === 'string' ? { coverageDirectory } : {}),
    files,
    ...(isObject(pattern) &&
    typeof pattern['source'] === 'string' &&
    typeof pattern['flags'] === 'string'
      ? { pattern: { flags: pattern['flags'], source: pattern['source'] } }
      : {}),
    root,
  }
}

async function execute(request: NodeExecutionRequest): Promise<NodeExecution> {
  const root = canonicalNodePath(request.root)
  const cases: NodeCase[] = []
  const coverageFiles = new Set<string>()
  const moduleFailures = new Set<string>()
  let success = true
  const pattern =
    request.pattern === undefined
      ? undefined
      : new RegExp(request.pattern.source, request.pattern.flags)
  const stream = runNodeTests({
    concurrency: false,
    coverage: request.coverage,
    cwd: request.root,
    files: [...request.files],
    ...(pattern === undefined ? {} : { testNamePatterns: pattern }),
  })

  for await (const event of stream) {
    if (
      event.type === 'test:fail' &&
      process.env['TIACORE_NODE_DEBUG'] === '1'
    ) {
      console.error(JSON.stringify(event.data))
    }
    if (event.type === 'test:coverage') {
      for (const file of event.data.summary.files) {
        const absoluteFile = canonicalNodePath(file.path)
        if (file.coveredLineCount > 0 && isInside(root, absoluteFile)) {
          coverageFiles.add(slash(relative(root, absoluteFile)))
        }
      }
      continue
    }

    if (event.type === 'test:summary') {
      success &&= event.data.success
      continue
    }

    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue

    const data = event.data
    if (
      (data.details.type !== undefined && data.details.type !== 'test') ||
      data.file === undefined
    ) {
      continue
    }
    const absoluteFile = canonicalNodePath(data.file)
    if (!isInside(root, absoluteFile)) continue
    const file = slash(relative(root, absoluteFile))
    // The file-level pseudo test: never a case, and a failure means the module did not load.
    if (
      data.name === data.file ||
      canonicalNodePath(resolve(root, data.name)) === absoluteFile
    ) {
      if (event.type === 'test:fail') moduleFailures.add(file)
      continue
    }

    const line = data.line ?? 1
    const column = data.column ?? 1
    cases.push({
      column,
      duration: data.details.duration_ms,
      file,
      fullName: data.name,
      id: nodeTestId(file, line, column, data.name),
      line,
      name: data.name,
      state:
        data.skip !== undefined
          ? 'skipped'
          : event.type === 'test:fail'
            ? 'failed'
            : 'passed',
    })
  }

  if (request.coverageDirectory !== undefined) {
    for (const file of readNodeV8CoverageFiles(
      request.coverageDirectory,
      root,
    )) {
      coverageFiles.add(file)
    }
  }

  return {
    cases,
    coverageFiles: [...coverageFiles].sort(byCodeUnit),
    moduleFailures: [...moduleFailures].sort(byCodeUnit),
    success,
  }
}

const requestFile = process.argv[2]
const outputFile = process.argv[3]

if (requestFile === undefined || outputFile === undefined) {
  throw new Error('Missing Node execution protocol paths')
}

const request = parseRequest(readFileSync(requestFile, 'utf8'))

try {
  writeFileSync(outputFile, JSON.stringify(await execute(request)))
} catch (error) {
  if (process.env['TIACORE_NODE_DEBUG'] === '1') console.error(error)
  const failure: NodeExecution = {
    cases: [],
    coverageFiles: [],
    moduleFailures: request.files.map((file) =>
      slash(relative(request.root, file)),
    ),
    success: false,
  }
  writeFileSync(outputFile, JSON.stringify(failure))
  process.exitCode = 1
}
