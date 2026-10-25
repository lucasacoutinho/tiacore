import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

// 1.x printed a usage error and the command's help on stderr and nothing on
// stdout, so a script that captures stdout never reads help as output.
// Requested help, versions and completions go to stdout.

const cli = resolve('dist/entries/cli.js')

function run(argv: readonly string[]) {
  const result = spawnSync(process.execPath, [cli, ...argv], {
    encoding: 'utf8',
  })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

describe('CLI usage output', () => {
  test.each([
    [[], undefined],
    [['--bogus'], 'Unrecognized flag: --bogus'],
    [['plan'], 'Missing required flag: --catalog'],
    [['k6', '--bogus'], 'Unrecognized flag: --bogus'],
    [['verify'], 'Missing required argument: command'],
  ])('%j writes the error and help to stderr only', (argv, message) => {
    const result = run(argv)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    if (message !== undefined) {
      expect(result.stderr.startsWith(message)).toBe(true)
    }
    expect(result.stderr).toContain('USAGE')
  })

  test.each([[['--help']], [['k6', '--help']], [['-v']]])(
    '%j writes to stdout only',
    (argv) => {
      const result = run(argv)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).not.toBe('')
    },
  )
})
