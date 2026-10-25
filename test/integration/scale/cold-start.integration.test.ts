import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  cold,
  createColdTemplate,
  current,
  old,
  removeColdTemplate,
  spawnedBy,
} from '../../support/cold-start.ts'

// Exact counts only; the timing budget against 1.x is in test/perf.

beforeAll(createColdTemplate)
afterAll(removeColdTemplate)

describe('cold start in a git project', () => {
  test('asks git three times to prepare and three times to commit, and nothing else', () => {
    const run = cold(current)
    expect(run.prepareSpawns).toEqual(['git', 'git', 'git'])
    expect(run.commitSpawns).toEqual(['git', 'git', 'git'])
  })

  test('starts fewer processes than 1.x', () => {
    expect(spawnedBy(cold(current))).toBeLessThan(spawnedBy(cold(old)))
  })
})
