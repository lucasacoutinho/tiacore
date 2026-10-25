import { readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import { NODE_ENGINES, PEER_RANGES, VERSION } from '../../src/core/version.ts'

const manifest: {
  engines: { node: string }
  peerDependencies: Record<string, string>
  version: string
} = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)

test('the runtime version matches the package version', () => {
  expect(VERSION).toBe(manifest.version)
})

test('`tiacore doctor` checks the engines and peer ranges the package declares', () => {
  expect(NODE_ENGINES).toBe(manifest.engines.node)
  expect(PEER_RANGES).toEqual(manifest.peerDependencies)
})
