import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  TIA_ARTIFACT_ATTESTATION_VERSION,
  TIA_ARTIFACT_MANIFEST_VERSION,
} from '../../src/core/artifacts.ts'
import { TIA_ADAPTER_CONFORMANCE_VERSION } from '../../src/core/conformance.ts'
import { TIA_PROTOCOL_VERSION } from '../../src/core/protocol.ts'
import { VERSION } from '../../src/core/version.ts'
import {
  TIA_VERIFICATION_RECEIPT_VERSION,
  TIA_VERIFICATION_SNAPSHOT_VERSION,
} from '../../src/core/verification.ts'
import { TIA_TYPESCRIPT_ADAPTER_VERSION } from '../../src/runners/adapter/types.ts'

// Port of 1.x test/unit/package/stable-release.test.ts. What changed, and why:
// - the 1.x version literal and `@types/istanbul-lib-instrument` dependency
//   (ADR 0004: no public declaration references that package any more);
// - the exports are the 2.0 ESM-only `dist/entries/*` layout (ADR 0004,
//   "Versioning and compatibility"), so the 1.x dual CJS/ESM shape has no
//   counterpart: the test pins the ESM-only shape instead;
// - the toolchain is pinned exactly in 2.0 (ADR 0004, migration slice 1).

interface PackageManifest {
  bin: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  engines: Record<string, string>
  exports: Record<string, string | Record<string, string>>
  files: string[]
  license: string
  main?: string
  module?: string
  name: string
  peerDependencies: Record<string, string>
  sideEffects: boolean
  type: string
  types: string
  version: string
}

interface JsonSchema {
  properties: Record<string, { const?: unknown }>
}

const root = process.cwd()

function json<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8'))
}

const specifierPattern = /(?:from\s+|import\()\s*['"]([^'"]+)['"]/gu

/** Every bare module specifier the public declaration files of the package reach. */
function publicDeclarationPackages(manifest: PackageManifest): Set<string> {
  const packages = new Set<string>()
  const seen = new Set<string>()
  const pending = Object.values(manifest.exports).flatMap((target) =>
    typeof target === 'string' || target['types'] === undefined
      ? []
      : [resolve(root, target['types'])],
  )
  while (pending.length > 0) {
    const file = pending.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(specifierPattern)) {
      const specifier = match[1] ?? ''
      if (!specifier.startsWith('.')) {
        packages.add(specifier)
        continue
      }
      // Emitted declarations keep the `.ts` spelling of relative imports.
      const target = resolve(dirname(file), specifier).replace(
        /\.(?:js|ts)$/u,
        '.d.ts',
      )
      if (existsSync(target)) pending.push(target)
    }
  }
  return packages
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
      },
      devDependencies: {
        '@types/istanbul-lib-instrument': '^1.7.8',
      },
      license: 'Apache-2.0',
      name: '@lucasacoutinho/tiacore',
      version: VERSION,
    })
    expect(VERSION).toBe('2.0.0-dev.0')
    // PEP 440 spelling of 2.0.0-dev.0
    expect(pythonProject).toMatch(/^version = "2\.0\.0\.dev0"$/m)
  })

  test('ships declaration types only for packages a consumer installs', () => {
    const packageJson = json<PackageManifest>('package.json')
    const referenced = publicDeclarationPackages(packageJson)

    expect(referenced.has('istanbul-lib-coverage')).toBe(true)
    expect(referenced.has('istanbul-lib-instrument')).toBe(false)
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
      './package.json',
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

  test('maps every entry point to an ESM file and declaration under dist/entries', () => {
    const packageJson = json<PackageManifest>('package.json')

    for (const [subpath, target] of Object.entries(packageJson.exports)) {
      if (subpath === './package.json') {
        expect(target).toBe('./package.json')
        continue
      }
      expect(typeof target).toBe('object')
      if (typeof target === 'string') continue
      const name =
        subpath === '.' ? 'index' : subpath.slice(2).replaceAll('/', '-')
      expect(target, subpath).toEqual({
        default: `./dist/entries/${name}.js`,
        types: `./dist/entries/${name}.d.ts`,
      })
      expect(existsSync(join(root, target['default'] ?? '')), subpath).toBe(
        true,
      )
      expect(existsSync(join(root, target['types'] ?? '')), subpath).toBe(true)
    }
    expect(packageJson.bin).toEqual({ tiacore: 'dist/entries/cli.js' })
    expect(existsSync(join(root, 'dist/entries/cli.js'))).toBe(true)
    expect(packageJson.types).toBe('./dist/entries/index.d.ts')
  })

  test('is ESM only and runs on Node 22.12 or newer', () => {
    const packageJson = json<PackageManifest>('package.json')

    expect(packageJson.type).toBe('module')
    expect(packageJson.sideEffects).toBe(false)
    expect(packageJson.main).toBeUndefined()
    expect(packageJson.module).toBeUndefined()
    expect(JSON.stringify(packageJson.exports)).not.toMatch(
      /"require"|\.cjs|\.cts/u,
    )
    expect(packageJson.engines).toEqual({ node: '^22.12.0 || >=24.0.0' })
  })

  test('uses the current compiler and bundler without narrowing Vite support', () => {
    const packageJson = json<PackageManifest>('package.json')

    expect(packageJson.devDependencies).toMatchObject({
      '@vitejs/plugin-react': '^6.1.2',
      typescript: '7.0.2',
      vite: '8.3.5',
    })
    expect(packageJson.peerDependencies).toMatchObject({
      '@playwright/test': '>=1.46.0 <2.0.0',
      vite: '>=6.0.0 <9.0.0',
      vitest: '>=4.1.0 <6.0.0',
    })
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
    const protocol = json<JsonSchema>('schemas/tiacore-impact-v1.schema.json')
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
