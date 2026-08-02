import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, test } from 'vitest'

import { certifyAdapterReceipt } from '../../../src/entries/conformance.js'

const sdkRoot = join(process.cwd(), 'sdks/go')

function sourceRevision(): string {
  const files: string[] = [join(sdkRoot, 'go.mod')]
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'testdata') walk(path)
      } else if (entry.isFile() && entry.name.endsWith('.go')) {
        if (!entry.name.endsWith('_test.go')) files.push(path)
      }
    }
  }
  walk(sdkRoot)
  const digest = createHash('sha256')
  for (const file of files.sort()) {
    digest.update(relative(sdkRoot, file).replaceAll('\\', '/'))
    digest.update('\0')
    digest.update(readFileSync(file))
    digest.update('\0')
  }
  return `sha256:${digest.digest('hex')}`
}

describe('Go SDK', () => {
  test('passes its native adapter suite', () => {
    const completed = spawnSync('go', ['test', '-count=1', './...'], {
      cwd: sdkRoot,
      encoding: 'utf8',
    })
    const output = `${completed.stdout}${completed.stderr}`
    expect(completed.status, output).toBe(0)
    expect(output).toContain('github.com/usescherie/tiacore/sdks/go')
  })

  test('has a capability-complete receipt tied to its source digest', () => {
    const receipt = JSON.parse(
      readFileSync(join(sdkRoot, 'certification/adapter.json'), 'utf8'),
    ) as unknown
    expect(certifyAdapterReceipt(receipt)).toMatchObject({
      adapter: 'go-test',
      capabilityLevel: 'static-impact',
      passedScenarios: 9,
      sourceRevision: sourceRevision(),
    })
  })
})
