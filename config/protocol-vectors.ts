// Usage: node config/protocol-vectors.ts write | check
//   write  regenerate conformance/protocol/v1/generated-plans.json from the TypeScript planner
//   check  fail if the committed file differs from what the planner produces today
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type {
  TiaExecutionPolicy,
  TiaImpactPlan,
  TiaSuiteDescriptor,
} from '../src/core/protocol.ts'
import { createImpactPlan } from '../src/engine/plan/protocol.ts'

export const GENERATED_PLANS = 'conformance/protocol/v1/generated-plans.json'
const SEED = 20_261_026
const COUNT = 400

export const INVALID_GRAPH_REASON_PREFIX = 'invalid impact graph: '

export interface GeneratedCase {
  readonly catalog: TiaSuiteDescriptor[]
  readonly changes: string[]
  readonly environmentFingerprint: string
  /** Set when the planner must throw instead of returning a plan. */
  readonly expectedError?: true
  /** Set when the plan falls back because the graph is invalid; only the prefix of `reason` is portable. */
  readonly expectedReasonPrefix?: string
  readonly expected?: TiaImpactPlan
  readonly fingerprint: string
  readonly graph: unknown
  readonly name: string
  readonly policy?: TiaExecutionPolicy
}

type Random = () => number

function mulberry32(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

class Dice {
  readonly next: Random
  constructor(seed: number) {
    this.next = mulberry32(seed)
  }
  int(limit: number): number {
    return Math.floor(this.next() * limit)
  }
  chance(probability: number): boolean {
    return this.next() < probability
  }
  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)] as T
  }
  subset<T>(values: readonly T[], probability: number): T[] {
    return values.filter(() => this.chance(probability))
  }
  shuffle<T>(values: readonly T[]): T[] {
    const copy = [...values]
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = this.int(index + 1)
      const held = copy[index] as T
      copy[index] = copy[other] as T
      copy[other] = held
    }
    return copy
  }
}

// Names around the BMP/astral boundary exercise UTF-16 code-unit ordering:
// U+FF21 sorts after U+1F600 by code point but before it by UTF-16 code unit.
const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta']
const ODD_NAMES = ['Ａwide', '\u{1F600}smile', 'café']
const SOURCES = [
  'src/a.ts',
  'src/b.ts',
  'src/c/d.ts',
  'src/gen/x.ts',
  'lib/util.py',
  'docs/README.md',
  'package.json',
  'config/runner.json',
  'config/deep/more.yaml',
  'yarn.lock',
  'a.cfg',
  'x.json',
  'tools/build.sh',
  '.github/ci.yml',
]
const ODD_SOURCES = ['src/Ａ.ts', 'src/\u{1F600}.ts', 'src/café.ts']
const INVALIDATORS = [
  { pattern: 'config/**', reason: 'configuration changed' },
  { pattern: '*.lock', reason: 'lockfile changed' },
  { pattern: 'package.json', reason: 'manifest changed' },
  { pattern: '**/*.cfg', reason: 'cfg changed' },
  { pattern: 'src/gen/**', reason: 'generated code changed' },
  { pattern: '?.json', reason: 'short json changed' },
  { pattern: '.github/**', reason: 'CI changed' },
  { pattern: 'src/*/d.ts', reason: 'nested d changed' },
]
const IGNORES = [
  'docs/**',
  '*.md',
  'tools/**',
  '**/*.yaml',
  'src/c/*',
  'lib/**',
  '.github/*.yml',
]
const LOCKS = ['browser', 'database', 'gpu', 'network']
const KINDS = ['import', 'executed', 'fixture', 'configuration', 'route']
const CONFIDENCES = ['exact', 'observed', 'inferred', 'conservative']

interface Suite extends TiaSuiteDescriptor {
  file: string
}

function makeCatalog(dice: Dice): Suite[] {
  const count = 1 + dice.int(6)
  const names = dice.shuffle([...NAMES, ...(dice.chance(0.3) ? ODD_NAMES : [])])
  const suites: Suite[] = []
  for (let index = 0; index < count; index += 1) {
    const name = names[index] as string
    const earlier = suites.map((suite) => suite.id)
    const dependsOn = dice.chance(0.5) ? dice.subset(earlier, 0.4) : []
    const resourceLocks = dice.chance(0.4) ? dice.subset(LOCKS, 0.5) : []
    const tags = dice.chance(0.2) ? ['slow'] : []
    suites.push({
      adapter: 'example',
      ...(dependsOn.length > 0 ? { dependsOn: dice.shuffle(dependsOn) } : {}),
      file: `test/${name}.test.ts`,
      id: `suite:${name}`,
      project: 'example',
      ...(resourceLocks.length > 0 ? { resourceLocks } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    })
  }
  return dice.shuffle(suites)
}

function messyPath(dice: Dice, path: string): string {
  switch (dice.int(8)) {
    case 0:
      return `./${path}`
    case 1:
      return path.replaceAll('/', '\\')
    case 2:
      return path.replace('/', '//')
    case 3:
      return `${path}/`
    case 4:
      return `x/../${path}`
    default:
      return path
  }
}

function makeGraph(
  dice: Dice,
  catalog: readonly Suite[],
  fingerprint: string,
  environmentFingerprint: string,
): Record<string, unknown> {
  const dropped = dice.chance(0.15) ? [dice.pick(catalog).id] : []
  const suites: Suite[] = catalog
    .filter((suite) => !dropped.includes(suite.id))
    .map((suite) =>
      dice.chance(0.1)
        ? { ...suite, file: suite.file.replace('.test.ts', '.spec.ts') }
        : suite,
    )
  if (dice.chance(0.15)) {
    suites.push({
      adapter: 'example',
      file: 'test/extra.test.ts',
      id: 'suite:extra',
      project: 'example',
    })
  }
  const ids = suites.map((suite) => suite.id)
  const sources = [...SOURCES, ...(dice.chance(0.3) ? ODD_SOURCES : [])]
  const observations = ids.flatMap((suiteId) =>
    dice.subset(sources, 0.2).map((source) => ({
      confidence: dice.pick(CONFIDENCES),
      kind: dice.pick(KINDS),
      source: dice.chance(0.2) ? messyPath(dice, source) : source,
      suiteId,
    })),
  )
  const invalidators = dice.chance(0.7)
    ? dice.subset(INVALIDATORS, 0.35)
    : undefined
  const knownSources = dice.chance(0.7) ? dice.subset(sources, 0.4) : undefined
  return {
    complete: !dice.chance(0.08),
    environmentFingerprint,
    fingerprint,
    ...(invalidators === undefined ? {} : { invalidators }),
    ...(knownSources === undefined ? {} : { knownSources }),
    observations: dice.shuffle(observations),
    protocolVersion: 1,
    suites: dice.shuffle(suites),
  }
}

function breakGraph(dice: Dice, graph: Record<string, unknown>): unknown {
  const suites = graph.suites as Suite[]
  switch (dice.int(7)) {
    case 0:
      return { ...graph, protocolVersion: 2 }
    case 1:
      return { ...graph, unsafeSkip: true }
    case 2:
      return { ...graph, knownSources: ['../outside.ts'] }
    case 3:
      return {
        ...graph,
        observations: [
          {
            confidence: 'exact',
            kind: 'import',
            source: 'src/a.ts',
            suiteId: 'suite:missing',
          },
        ],
      }
    case 4: {
      const first = suites[0]
      return first === undefined
        ? { ...graph, complete: 'yes' }
        : {
            ...graph,
            suites: [{ ...first, dependsOn: [first.id] }, ...suites.slice(1)],
          }
    }
    case 5:
      return {
        ...graph,
        suites: [...suites, ...suites.slice(0, 1)].slice(0, suites.length + 1),
      }
    default: {
      const { fingerprint: _removed, ...rest } = graph
      return rest
    }
  }
}

function makeChanges(
  dice: Dice,
  catalog: readonly Suite[],
  graph: Record<string, unknown>,
): string[] {
  const observed = (
    graph.observations as readonly { readonly source: string }[]
  ).map((observation) => observation.source)
  const known = (graph.knownSources as readonly string[] | undefined) ?? []
  const files = (graph.suites as readonly Suite[]).map((suite) => suite.file)
  const wide = [
    ...SOURCES,
    ...ODD_SOURCES,
    ...catalog.map((suite) => suite.file),
    'test/unseen.test.ts',
    'other/new.txt',
  ]
  const pool = dice.chance(0.25) ? wide : [...observed, ...known, ...files]
  if (pool.length === 0) return []
  const count = dice.chance(0.15) ? 0 : 1 + dice.int(3)
  const picked: string[] = []
  for (let index = 0; index < count; index += 1) {
    const path = dice.pick(pool)
    picked.push(dice.chance(0.25) ? messyPath(dice, path) : path)
  }
  if (dice.chance(0.1) && picked[0] !== undefined) picked.push(picked[0])
  return picked
}

function makePolicy(
  dice: Dice,
  catalog: readonly Suite[],
  fingerprint: string,
  environmentFingerprint: string,
): TiaExecutionPolicy | undefined {
  if (dice.chance(0.4)) return undefined
  const policy: TiaExecutionPolicy = {
    ...(dice.chance(0.3)
      ? {
          allowedSuites: dice.subset(
            catalog.map((suite) => suite.id),
            0.6,
          ),
        }
      : {}),
    ...(dice.chance(0.05) ? { forceFull: true } : {}),
    ...(dice.chance(0.3) ? { ignoreChanges: dice.subset(IGNORES, 0.4) } : {}),
    ...(dice.chance(0.25)
      ? { onUnknownChange: dice.chance(0.5) ? 'ignore' : 'full' }
      : {}),
    ...(dice.chance(0.08)
      ? {
          expectedFingerprint: dice.chance(0.5)
            ? fingerprint
            : 'other-structure',
        }
      : {}),
    ...(dice.chance(0.08)
      ? {
          expectedEnvironmentFingerprint: dice.chance(0.5)
            ? environmentFingerprint
            : 'other-environment',
        }
      : {}),
  }
  return Object.keys(policy).length === 0 ? undefined : policy
}

function makeCase(dice: Dice, index: number): GeneratedCase {
  let catalog = makeCatalog(dice)
  const fingerprint = 'project-v1'
  const environmentFingerprint = dice.pick(['node-24', 'python-3.12', ''])
  const stored = makeGraph(dice, catalog, fingerprint, environmentFingerprint)
  const mismatch = dice.int(20)
  let graph: unknown = stored
  let currentFingerprint = fingerprint
  let currentEnvironment = environmentFingerprint
  if (mismatch === 0) currentFingerprint = 'project-v2'
  else if (mismatch === 1) currentEnvironment = 'other-env'
  else if (mismatch === 2) graph = null
  else if (mismatch === 3) graph = breakGraph(dice, stored)
  if (dice.chance(0.04)) {
    // A catalog that fails validation: dependency on an unknown suite.
    const [first, ...rest] = catalog
    if (first !== undefined) {
      catalog = [{ ...first, dependsOn: ['suite:nowhere'] }, ...rest]
    }
  }
  const policy = makePolicy(dice, catalog, fingerprint, environmentFingerprint)
  const policyWithUnknown =
    dice.chance(0.03) && policy !== undefined
      ? { ...policy, allowedSuites: ['suite:ghost'] }
      : policy
  const changes = dice.chance(0.03)
    ? ['x/../', 'src/a.ts']
    : makeChanges(dice, catalog, stored)
  const base = {
    catalog,
    changes,
    environmentFingerprint: currentEnvironment,
    fingerprint: currentFingerprint,
    graph,
    name: `generated ${String(index).padStart(3, '0')}`,
    ...(policyWithUnknown === undefined ? {} : { policy: policyWithUnknown }),
  }
  try {
    const expected = createImpactPlan({
      catalog,
      changes: { files: changes },
      currentEnvironmentFingerprint: currentEnvironment,
      currentFingerprint,
      graph: graph as never,
      ...(policyWithUnknown === undefined ? {} : { policy: policyWithUnknown }),
    })
    return expected.reason.startsWith(INVALID_GRAPH_REASON_PREFIX)
      ? {
          ...base,
          expected,
          expectedReasonPrefix: INVALID_GRAPH_REASON_PREFIX,
        }
      : { ...base, expected }
  } catch {
    return { ...base, expectedError: true }
  }
}

export function generateVectors(): string {
  const dice = new Dice(SEED)
  const cases = Array.from({ length: COUNT }, (_, index) =>
    makeCase(dice, index),
  )
  return `${JSON.stringify({ cases, protocolVersion: 1, seed: SEED }, null, 1)}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode = 'check'] = process.argv.slice(2)
  if (mode === 'write') {
    writeFileSync(GENERATED_PLANS, generateVectors())
  } else if (mode === 'check') {
    let committed = ''
    try {
      committed = readFileSync(GENERATED_PLANS, 'utf8')
    } catch {
      committed = ''
    }
    if (committed !== generateVectors()) {
      console.error(
        `${GENERATED_PLANS} differs from the TypeScript planner; run with write`,
      )
      process.exitCode = 1
    }
  } else {
    console.error(`unknown mode ${mode}`)
    process.exitCode = 2
  }
}
