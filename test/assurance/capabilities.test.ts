import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, test } from 'vitest'

import { parseAdapterCapabilities } from '../support/adapter-capabilities.ts'

const root = process.cwd()
const document: unknown = JSON.parse(
  readFileSync(
    join(root, 'docs/protocol/capabilities/adapter-capabilities-v1.json'),
    'utf8',
  ),
)
const contract = parseAdapterCapabilities(document)
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

describe('adapter capability contract', () => {
  test('covers every supported runner entry point exactly once', () => {
    expect(contract.contractVersion).toBe(1)
    expect(contract.adapters.map(({ id }) => id).sort()).toEqual([
      'bun-test',
      'go-test',
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
    // The capability contract ships with the protocol docs.
    expect(packageJson.files).toContain('docs')
    expect(packageJson.exports).toHaveProperty('./vitest')
    expect(packageJson.exports).toHaveProperty('./adapter')
    expect(packageJson.exports).toHaveProperty('./workspace')

    for (const adapter of contract.adapters) {
      if (adapter.entryPoint.startsWith('@lucasacoutinho/tiacore')) {
        const exportKey = adapter.entryPoint.replace(
          '@lucasacoutinho/tiacore',
          '.',
        )
        expect(packageJson.exports).toHaveProperty([exportKey])
      } else {
        expect([
          'go:github.com/lucasacoutinho/tiacore/sdks/go',
          'python:tiacore',
        ]).toContain(adapter.entryPoint)
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
    expect(contract.adapters.find(({ id }) => id === 'go-test')).toMatchObject({
      cachedOutcomes: false,
      capabilityLevel: 'static-impact',
      nativeParallelism: true,
      selectionGranularity: 'package',
    })
    expect(
      contract.adapters
        .filter(({ coverageReconstruction }) => coverageReconstruction)
        .map(({ id }) => id),
    ).toEqual(['vitest'])
  })

  test('the decoder is at least as strict as the committed JSON Schema', () => {
    const ajv = new Ajv2020({ strict: false })
    const validate = ajv.compile(
      JSON.parse(
        readFileSync(
          join(
            root,
            'docs/protocol/schemas/tiacore-adapter-capabilities-v1.schema.json',
          ),
          'utf8',
        ),
      ),
    )
    expect(validate(document)).toBe(true)
    const adapter = { ...contract.adapters[0] }
    const broken: unknown[] = [
      { contractVersion: 1, adapters: [{ ...adapter, extra: 1 }] },
      { contractVersion: 2, adapters: [adapter] },
      { contractVersion: 1, adapters: [] },
      { contractVersion: 1, adapters: [adapter, adapter] },
      {
        contractVersion: 1,
        adapters: [{ ...adapter, cachedOutcomes: false }],
      },
      {
        contractVersion: 1,
        adapters: [
          {
            ...adapter,
            capabilityLevel: 'static-impact',
            dependencyEvidence: 'runtime',
          },
        ],
      },
    ]
    for (const value of broken) {
      expect(() => parseAdapterCapabilities(value)).toThrow(
        /TIA adapter capabilities/,
      )
    }
  })
})
