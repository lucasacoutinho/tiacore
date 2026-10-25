import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import {
  TiaPlaywrightRunner,
  reporterPath,
  tia,
} from '../../src/runners/playwright/index.ts'

const dist = new URL('../../dist/entries/', import.meta.url)

describe('tia()', () => {
  test('with no argument returns the reporter tuple', async () => {
    const built = await import(new URL('playwright.js', dist).href)
    const tuple = built.tia()
    expect(tuple).toHaveLength(1)
    expect(isAbsolute(tuple[0])).toBe(true)
    expect(tuple[0]).toBe(
      fileURLToPath(new URL('playwright-reporter.js', dist)),
    )
    expect(existsSync(tuple[0])).toBe(true)
  })

  test('finds the reporter from the entry and from a chunk beside it', () => {
    expect(reporterPath(new URL('playwright.js', dist).href)).toBe(
      fileURLToPath(new URL('playwright-reporter.js', dist)),
    )
    expect(reporterPath(new URL('chunks/chunk-x.js', dist).href)).toBe(
      fileURLToPath(new URL('playwright-reporter.js', dist)),
    )
  })

  test('with options returns a runner without validating them', () => {
    expect(tia({ name: 'qa' })).toBeInstanceOf(TiaPlaywrightRunner)
    expect(() => tia({} as never)).not.toThrow()
  })

  test('rejects an unusable name when the runner runs, not when it is built', async () => {
    const runner = tia({ name: '---' })
    await expect(runner.run()).rejects.toThrow(
      'Playwright TIA name must contain a letter or number.',
    )
  })

  test('with a test type returns an extended test type', () => {
    const calls: unknown[] = []
    const base = Object.assign(() => undefined, {
      extend: (fixtures: unknown) => {
        calls.push(fixtures)
        return 'extended'
      },
    })
    expect(tia(base as never)).toBe('extended')
    expect(Object.keys(calls[0] as object)).toEqual(['_tiaDependencies'])
    expect(
      (calls[0] as { _tiaDependencies: [unknown, object] })._tiaDependencies[1],
    ).toEqual({
      auto: true,
    })
  })
})
