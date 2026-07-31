import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { TIA_TYPESCRIPT_ADAPTER_VERSION } from '../../../src/adapter/types.js'
import { TIA_ADAPTER_CONFORMANCE_VERSION } from '../../../src/conformance/certification.js'
import {
  TIA_ARTIFACT_ATTESTATION_VERSION,
  TIA_ARTIFACT_MANIFEST_VERSION,
} from '../../../src/engine/artifacts/types.js'
import { TIA_PROTOCOL_VERSION } from '../../../src/protocol/types.js'
import { PLUGIN_VERSION } from '../../../src/shared/constants.js'
import {
  TIA_VERIFICATION_RECEIPT_VERSION,
  TIA_VERIFICATION_SNAPSHOT_VERSION,
} from '../../../src/verification/types.js'

interface PackageManifest {
  dependencies: Record<string, string>
  exports: Record<string, unknown>
  files: string[]
  license: string
  name: string
  version: string
}

interface JsonSchema {
  properties: Record<string, { const?: unknown }>
}

const root = process.cwd()

function json<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as T
}

describe('stable release contract', () => {
  test('keeps package and SDK release versions aligned', () => {
    const packageJson = json<PackageManifest>('package.json')
    const pythonProject = readFileSync(
      join(root, 'sdks/python/pyproject.toml'),
      'utf8',
    )

    expect(packageJson).toMatchObject({
      dependencies: {
        '@types/istanbul-lib-coverage': '^2.0.6',
        '@types/istanbul-lib-instrument': '^1.7.8',
      },
      license: 'UNLICENSED',
      name: '@usescherie/tiacore',
      version: PLUGIN_VERSION,
    })
    expect(PLUGIN_VERSION).toBe('1.0.0')
    expect(pythonProject).toMatch(/^version = "1\.0\.0"$/m)
  })

  test('freezes the supported package entry points', () => {
    const packageJson = json<PackageManifest>('package.json')

    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      './adapter',
      './artifacts',
      './bun',
      './conformance',
      './core',
      './evidence',
      './gradle',
      './k6',
      './maestro',
      './node',
      './playwright',
      './playwright/reporter',
      './protocol',
      './verification',
      './vitest',
      './workspace',
    ])
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        'capabilities',
        'conformance',
        'dist',
        'docs',
        'schemas',
        'spec',
        'README.md',
        'CHANGELOG.md',
        'LICENSE',
        'SECURITY.md',
      ]),
    )
  })

  test('freezes every published contract version', () => {
    expect({
      adapter: TIA_TYPESCRIPT_ADAPTER_VERSION,
      artifactAttestation: TIA_ARTIFACT_ATTESTATION_VERSION,
      artifactManifest: TIA_ARTIFACT_MANIFEST_VERSION,
      conformance: TIA_ADAPTER_CONFORMANCE_VERSION,
      protocol: TIA_PROTOCOL_VERSION,
      verificationReceipt: TIA_VERIFICATION_RECEIPT_VERSION,
      verificationSnapshot: TIA_VERIFICATION_SNAPSHOT_VERSION,
    }).toEqual({
      adapter: 1,
      artifactAttestation: 1,
      artifactManifest: 1,
      conformance: 1,
      protocol: 1,
      verificationReceipt: 2,
      verificationSnapshot: 1,
    })

    const attestation = json<JsonSchema>(
      'schemas/tiacore-artifact-attestation-v1.schema.json',
    )
    const manifest = json<JsonSchema>(
      'schemas/tiacore-artifact-manifest-v1.schema.json',
    )
    const protocol = json<JsonSchema>(
      'schemas/tiacore-impact-v1.schema.json',
    )
    expect(attestation.properties.version?.const).toBe(
      TIA_ARTIFACT_ATTESTATION_VERSION,
    )
    expect(manifest.properties.version?.const).toBe(
      TIA_ARTIFACT_MANIFEST_VERSION,
    )
    expect(protocol.properties.protocolVersion?.const).toBe(
      TIA_PROTOCOL_VERSION,
    )
  })
})
