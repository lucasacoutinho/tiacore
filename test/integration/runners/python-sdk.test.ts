import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  readFileSync,
  readdirSync,
} from 'node:fs'
import {
  join,
  relative,
} from 'node:path'

import { describe, expect, test } from 'vitest'

import { certifyAdapterReceipt } from '../../../src/entries/conformance.js'

const sdkRoot = join(process.cwd(), 'sdks/python')

function sourceRevision(): string {
  const root = join(sdkRoot, 'src')
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  walk(root)
  const digest = createHash('sha256')
  for (const file of files.sort()) {
    digest.update(relative(root, file).replaceAll('\\', '/'))
    digest.update('\0')
    digest.update(readFileSync(file))
    digest.update('\0')
  }
  return `sha256:${digest.digest('hex')}`
}

describe('Python pytest SDK', () => {
  test('passes shared protocol and executable adapter suites', () => {
    const completed = spawnSync(
      'python3',
      ['-m', 'unittest', 'discover', '-s', 'tests', '-v'],
      {
        cwd: sdkRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
        },
      },
    )
    const output = `${completed.stdout}${completed.stderr}`
    expect(completed.status, output).toBe(0)
    expect(output).toContain('OK')
  })

  test('has a capability-complete receipt tied to its source digest', () => {
    const receipt = JSON.parse(
      readFileSync(
        join(sdkRoot, 'certification/adapter.json'),
        'utf8',
      ),
    ) as unknown
    expect(certifyAdapterReceipt(receipt)).toMatchObject({
      adapter: 'pytest',
      capabilityLevel: 'static-impact',
      passedScenarios: 9,
      sourceRevision: sourceRevision(),
    })
  })
})
