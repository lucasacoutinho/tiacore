import { readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import { VERSION } from '../../src/core/version.ts'

test('the runtime version matches the package version', () => {
  const manifest: { version: string } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  )
  expect(VERSION).toBe(manifest.version)
})
