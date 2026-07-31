import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

interface AdapterCapability {
  baselines: string[]
  boundaries: string[]
  cachedOutcomes: boolean
  capabilityLevel: 'observed-file-tia' | 'runtime-tia' | 'static-impact'
  coverageReconstruction: boolean
  dependencyEvidence: 'runtime' | 'runtime-and-static' | 'static'
  entryPoint: string
  factory: 'tia' | null
  id: string
  nativeParallelism: boolean
  selectionGranularity: 'flow' | 'profile' | 'test-case' | 'test-file'
}

interface CapabilityContract {
  adapters: AdapterCapability[]
  contractVersion: number
}

const root = process.cwd()
const contract = JSON.parse(
  readFileSync(join(root, 'capabilities/adapter-capabilities-v1.json'), 'utf8'),
) as CapabilityContract
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
) as { exports: Record<string, unknown>; files: string[] }

describe('adapter capability contract', () => {
  test('covers every supported runner entry point exactly once', () => {
    expect(contract.contractVersion).toBe(1)
    expect(contract.adapters.map(({ id }) => id).sort()).toEqual([
      'bun-test',
      'gradle-junit',
      'k6',
      'maestro',
      'node-test',
      'playwright',
      'pytest',
      'vitest',
    ])
    expect(new Set(contract.adapters.map(({ id }) => id)).size).toBe(
      contract.adapters.length,
    )
    expect(packageJson.files).toContain('capabilities')
    expect(packageJson.exports).toHaveProperty('./vitest')
    expect(packageJson.exports).toHaveProperty('./adapter')
    expect(packageJson.exports).toHaveProperty('./workspace')

    for (const adapter of contract.adapters) {
      if (adapter.entryPoint.startsWith('@usescherie/tiacore')) {
        const exportKey = adapter.entryPoint.replace('@usescherie/tiacore', '.')
        expect(packageJson.exports).toHaveProperty(
          exportKey === '.' ? '.' : exportKey,
        )
      } else {
        expect(adapter.entryPoint).toBe('python:tiacore')
      }
      expect(adapter.baselines.length).toBeGreaterThan(0)
      expect(adapter.boundaries.every((boundary) => boundary.length > 0)).toBe(
        true,
      )
    }
  })

  test('reserves runtime TIA claims for adapters with cached outcomes', () => {
    for (const adapter of contract.adapters) {
      if (adapter.capabilityLevel === 'runtime-tia') {
        expect(adapter.dependencyEvidence).toBe('runtime')
        expect(adapter.cachedOutcomes).toBe(true)
        expect(adapter.selectionGranularity).toBe('test-case')
        expect(adapter.factory).toBe('tia')
      }
      if (adapter.capabilityLevel === 'static-impact') {
        expect(adapter.dependencyEvidence).toBe('static')
        expect(adapter.cachedOutcomes).toBe(false)
        expect(adapter.coverageReconstruction).toBe(false)
      }
    }
  })

  test('does not overstate Playwright or coverage fidelity', () => {
    expect(
      contract.adapters.find(({ id }) => id === 'gradle-junit'),
    ).toMatchObject({
      capabilityLevel: 'static-impact',
      nativeParallelism: true,
      selectionGranularity: 'test-file',
    })
    expect(
      contract.adapters.find(({ id }) => id === 'playwright'),
    ).toMatchObject({
      cachedOutcomes: false,
      capabilityLevel: 'observed-file-tia',
      coverageReconstruction: false,
      selectionGranularity: 'test-file',
    })
    expect(
      contract.adapters
        .filter(({ coverageReconstruction }) => coverageReconstruction)
        .map(({ id }) => id),
    ).toEqual(['vitest'])
  })
})
