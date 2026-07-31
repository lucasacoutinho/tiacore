import { describe, expect, test } from 'vitest'

import {
  createImpactPlan,
  mergeImpactGraphs,
} from '../../../src/protocol/planner.js'
import {
  normalizeProtocolPath,
  normalizeProtocolPaths,
} from '../../../src/protocol/paths.js'
import {
  TIA_PROTOCOL_VERSION,
  type TiaImpactGraph,
  type TiaSuiteDescriptor,
} from '../../../src/protocol/types.js'
import { parseImpactGraph } from '../../../src/protocol/validate.js'

const catalog: TiaSuiteDescriptor[] = [
  {
    adapter: 'maestro',
    file: 'e2e/login.yaml',
    id: 'maestro:login',
    project: 'platform',
    resourceLocks: ['android-emulator'],
  },
  {
    adapter: 'maestro',
    dependsOn: ['maestro:login'],
    file: 'e2e/settings.yaml',
    id: 'maestro:settings',
    project: 'platform',
    resourceLocks: ['android-emulator'],
  },
]

function graph(): TiaImpactGraph {
  return {
    complete: true,
    environmentFingerprint: 'android-35',
    fingerprint: 'project-v1',
    invalidators: [
      {
        pattern: 'android/**',
        reason: 'native project changed',
      },
    ],
    knownSources: ['docs/README.md'],
    observations: [
      {
        confidence: 'observed',
        kind: 'executed',
        source: 'src/login.ts',
        suiteId: 'maestro:login',
      },
      {
        confidence: 'inferred',
        kind: 'route',
        source: 'src/settings.ts',
        suiteId: 'maestro:settings',
      },
    ],
    protocolVersion: TIA_PROTOCOL_VERSION,
    suites: catalog,
  }
}

describe('runner-neutral TIA protocol', () => {
  test('normalizes portable paths and rejects escapes', () => {
    expect(normalizeProtocolPath('.\\src\\feature.ts')).toBe('src/feature.ts')
    expect(normalizeProtocolPaths(['src/b.ts', 'src\\a.ts', './src/a.ts'])).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
    expect(() => normalizeProtocolPath('../outside.ts')).toThrow(
      /project-relative/,
    )
    expect(() => normalizeProtocolPath('C:\\repo\\src\\a.ts')).toThrow(
      /project-relative/,
    )
  })

  test('rejects unsupported versions and dangling suite references', () => {
    expect(() =>
      parseImpactGraph({ ...graph(), protocolVersion: 2 }),
    ).toThrow(/unsupported TIA protocol version/)
    expect(() =>
      parseImpactGraph({
        ...graph(),
        observations: [
          {
            confidence: 'exact',
            kind: 'import',
            source: 'src/a.ts',
            suiteId: 'missing',
          },
        ],
      }),
    ).toThrow(/unknown suite/)
  })

  test('selects observed suites and their dependencies', () => {
    const plan = createImpactPlan({
      catalog,
      changes: { files: ['src/settings.ts'], provider: 'explicit' },
      currentEnvironmentFingerprint: 'android-35',
      currentFingerprint: 'project-v1',
      graph: graph(),
    })

    expect(plan.mode).toBe('selective')
    expect(plan.selected).toEqual(['maestro:login', 'maestro:settings'])
    expect(plan.cached).toEqual([])
    expect(plan.resourceLocks).toEqual(['android-emulator'])
    expect(plan.reasons['maestro:login']).toEqual([
      'dependency of maestro:settings',
    ])
  })

  test('skips known unaffected changes without inventing fresh results', () => {
    const plan = createImpactPlan({
      catalog,
      changes: { files: ['docs/README.md'] },
      currentEnvironmentFingerprint: 'android-35',
      currentFingerprint: 'project-v1',
      graph: graph(),
    })

    expect(plan).toMatchObject({
      cached: ['maestro:login', 'maestro:settings'],
      mode: 'skip',
      selected: [],
    })
  })

  test('falls back to the authorized full lane for unsafe inputs', () => {
    const unknown = createImpactPlan({
      catalog,
      changes: { files: ['src/unknown.ts'] },
      currentEnvironmentFingerprint: 'android-35',
      currentFingerprint: 'project-v1',
      graph: graph(),
      policy: { allowedSuites: ['maestro:login'] },
    })
    expect(unknown).toMatchObject({
      mode: 'full',
      selected: ['maestro:login'],
    })

    const structural = createImpactPlan({
      catalog,
      changes: { files: ['android/app/build.gradle'] },
      currentEnvironmentFingerprint: 'android-35',
      currentFingerprint: 'project-v1',
      graph: graph(),
    })
    expect(structural.mode).toBe('full')
    expect(structural.reason).toContain('native project changed')

    const environment = createImpactPlan({
      catalog,
      changes: { files: [] },
      currentEnvironmentFingerprint: 'android-36',
      currentFingerprint: 'project-v1',
      graph: graph(),
    })
    expect(environment.reason).toBe('execution environment changed')
  })

  test('never expands beyond the suites authorized by policy', () => {
    const plan = createImpactPlan({
      catalog,
      changes: { files: ['src/settings.ts'] },
      currentEnvironmentFingerprint: 'android-35',
      currentFingerprint: 'project-v1',
      graph: graph(),
      policy: { allowedSuites: ['maestro:login'] },
    })

    expect(plan).toMatchObject({
      cached: ['maestro:login'],
      mode: 'skip',
      selected: [],
    })
  })

  test('merges compatible graph partitions deterministically', () => {
    const first = graph()
    first.suites = [catalog[0]!]
    first.observations = [first.observations[0]!]
    const second = graph()
    second.suites = [catalog[1]!]
    second.suites[0] = { ...second.suites[0]!, dependsOn: [] }
    second.observations = [second.observations[1]!]

    const merged = mergeImpactGraphs([second, first])

    expect(merged.suites.map((suite) => suite.id)).toEqual([
      'maestro:login',
      'maestro:settings',
    ])
    expect(merged.observations).toHaveLength(2)
    expect(merged.knownSources).toEqual(['docs/README.md'])
  })
})
