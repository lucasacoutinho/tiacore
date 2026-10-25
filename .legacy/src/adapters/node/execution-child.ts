import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { run as runNodeTests } from 'node:test'

import { readNodeV8CoverageFiles } from './coverage.js'
import { canonicalNodePath } from './discovery.js'
import { isInside, slash } from '../../shared/paths.js'

interface NodeExecutionRequest {
  coverage: boolean
  coverageDirectory?: string
  files: string[]
  pattern?: {
    flags: string
    source: string
  }
  root: string
}

interface NodeCase {
  column: number
  duration?: number
  file: string
  fullName: string
  id: string
  line: number
  name: string
  state: 'failed' | 'passed' | 'skipped'
}

interface NodeExecution {
  cases: NodeCase[]
  coverageFiles: string[]
  moduleFailures: string[]
  success: boolean
}

function testId(
  file: string,
  line: number,
  column: number,
  name: string,
): string {
  return `${file}:${line}:${column}:${name}`
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
    files: request.files,
    ...(pattern === undefined ? {} : { testNamePatterns: pattern }),
  })

  for await (const event of stream) {
    if (event.type === 'test:fail' && process.env.TIACORE_NODE_DEBUG === '1') {
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

    if (event.type !== 'test:pass' && event.type !== 'test:fail') {
      continue
    }

    const data = event.data
    if (
      (data.details.type !== undefined && data.details.type !== 'test') ||
      data.file === undefined
    ) {
      continue
    }
    const absoluteFile = canonicalNodePath(data.file)
    if (!isInside(root, absoluteFile)) {
      continue
    }
    const file = slash(relative(root, absoluteFile))
    if (
      data.name === data.file ||
      canonicalNodePath(resolve(root, data.name)) === absoluteFile
    ) {
      if (event.type === 'test:fail') {
        moduleFailures.add(file)
      }
      continue
    }

    const line = data.line ?? 1
    const column = data.column ?? 1
    cases.push({
      column,
      duration: data.details.duration_ms,
      file,
      fullName: data.name,
      id: testId(file, line, column, data.name),
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
    coverageFiles: [...coverageFiles].sort(),
    moduleFailures: [...moduleFailures].sort(),
    success,
  }
}

const requestFile = process.argv[2]
const outputFile = process.argv[3]

if (requestFile === undefined || outputFile === undefined) {
  throw new Error('Missing Node execution protocol paths')
}

const request = JSON.parse(
  readFileSync(requestFile, 'utf8'),
) as NodeExecutionRequest

try {
  writeFileSync(outputFile, JSON.stringify(await execute(request)))
} catch (error) {
  if (process.env.TIACORE_NODE_DEBUG === '1') {
    console.error(error)
  }
  writeFileSync(
    outputFile,
    JSON.stringify({
      cases: [],
      coverageFiles: [],
      moduleFailures: request.files.map((file) =>
        slash(relative(request.root, file)),
      ),
      success: false,
    } satisfies NodeExecution),
  )
  process.exitCode = 1
}
