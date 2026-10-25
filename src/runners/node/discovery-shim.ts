import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Replaces `node:test` while a test file is discovered: calls to test/it write
// a record and never run the callback, so discovery executes no test bodies.
// This module is an esbuild entry point; the register script redirects both
// `import 'node:test'` and `require('node:test')` here.

interface DiscoveryRecord {
  column: number
  file: string
  fullName: string
  line: number
  name: string
  skipped: boolean
}

type Definition = (...arguments_: unknown[]) => void
type DefinitionFunction = Definition & {
  only: Definition
  skip: Definition
  todo: Definition
}

const output = process.env['TIACORE_NODE_DISCOVERY_FILE']
const suites: Array<{ name: string; skipped: boolean }> = []
const ownLocations = [import.meta.url, fileURLToPath(import.meta.url)]

const FRAME = /\(?((?:file:\/\/\/|[a-z]:[\\/]|\/).+):(\d+):(\d+)\)?$/iu

function sourceLocation(): {
  column: number
  file: string
  line: number
} | null {
  const stack = new Error().stack?.split('\n').slice(1) ?? []
  for (const line of stack) {
    if (ownLocations.some((own) => line.includes(own))) continue
    const match = FRAME.exec(line.trim())
    if (match?.[1] === undefined) continue
    try {
      return {
        column: Number(match[3] ?? 1),
        file: match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1],
        line: Number(match[2] ?? 1),
      }
    } catch {
      continue
    }
  }
  return null
}

function definitionArguments(arguments_: unknown[]): {
  callback: ((this: unknown) => unknown) | null
  name: string
  skipped: boolean
} {
  const last = arguments_.at(-1)
  const callback =
    typeof last === 'function' ? (last as (this: unknown) => unknown) : null
  const first = arguments_[0]
  const name =
    typeof first === 'string' ? first : callback?.name || '<anonymous>'
  const options = arguments_.find(
    (argument): argument is { skip?: unknown; todo?: unknown } =>
      typeof argument === 'object' &&
      argument !== null &&
      !Array.isArray(argument),
  )
  return {
    callback,
    name,
    skipped: Boolean(options?.skip || options?.todo),
  }
}

function write(record: DiscoveryRecord): void {
  if (output !== undefined && output !== '') {
    appendFileSync(output, `${JSON.stringify(record)}\n`)
  }
}

function defineTest(forcedSkipped: boolean, arguments_: unknown[]): void {
  const definition = definitionArguments(arguments_)
  const location = sourceLocation()
  if (location === null) return
  write({
    ...location,
    fullName: [...suites.map((suite) => suite.name), definition.name].join(' '),
    name: definition.name,
    skipped:
      forcedSkipped ||
      definition.skipped ||
      suites.some((suite) => suite.skipped),
  })
}

const test: DefinitionFunction = Object.assign(
  (...arguments_: unknown[]) => {
    defineTest(false, arguments_)
  },
  {
    only: (...arguments_: unknown[]) => {
      defineTest(false, arguments_)
    },
    skip: (...arguments_: unknown[]) => {
      defineTest(true, arguments_)
    },
    todo: (...arguments_: unknown[]) => {
      defineTest(true, arguments_)
    },
  },
)

function defineSuite(forcedSkipped: boolean, arguments_: unknown[]): void {
  const definition = definitionArguments(arguments_)
  if (definition.callback === null) return
  suites.push({
    name: definition.name,
    skipped: forcedSkipped || definition.skipped,
  })
  try {
    definition.callback.call({
      name: definition.name,
      signal: new AbortController().signal,
    })
  } finally {
    suites.pop()
  }
}

const describe: DefinitionFunction = Object.assign(
  (...arguments_: unknown[]) => {
    defineSuite(false, arguments_)
  },
  {
    only: (...arguments_: unknown[]) => {
      defineSuite(false, arguments_)
    },
    skip: (...arguments_: unknown[]) => {
      defineSuite(true, arguments_)
    },
    todo: (...arguments_: unknown[]) => {
      defineSuite(true, arguments_)
    },
  },
)

const noop = (): void => {}
const noopObject = new Proxy({}, { get: () => noop })
const emptyRun = (): AsyncIterable<never> => ({
  async *[Symbol.asyncIterator]() {},
})

Object.assign(test, {
  after: noop,
  afterEach: noop,
  before: noop,
  beforeEach: noop,
  describe,
  it: test,
  mock: noopObject,
  suite: describe,
})

const { only, skip, todo } = test

export {
  noop as after,
  noop as afterEach,
  noop as before,
  noop as beforeEach,
  describe,
  only,
  skip,
  test as it,
  test,
  todo,
  describe as suite,
}
export const assert = noopObject
export const expectFailure = noop
export const mock = noopObject
export const run = emptyRun
export const snapshot = noopObject
export default test
