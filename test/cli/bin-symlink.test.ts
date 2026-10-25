import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

// The packaged binary starts through a symlink and lists its commands and
// adapter groups. Help text is outside the public contract, so the assertions
// read only the command names under the SUBCOMMANDS heading.

const temporaryDirectories: string[] = []
const cli = resolve('dist/entries/cli.js')

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-bin-'))
  temporaryDirectories.push(root)
  return root
}

function run(binary: string, args: readonly string[]): string {
  return execFileSync(binary, args, { encoding: 'utf8' })
}

/** The command names listed under the SUBCOMMANDS heading of a help screen. */
function subcommands(help: string): string[] {
  const section = help.split('SUBCOMMANDS\n')[1] ?? ''
  return section
    .split('\n')
    .filter((line) => /^ {2}\S/u.test(line))
    .map((line) => line.trim().split(/\s+/u)[0] ?? '')
}

const manifest: { version: string } = JSON.parse(
  readFileSync('package.json', 'utf8'),
)

describe('tiacore CLI', () => {
  test('runs through a package-manager style executable symlink', () => {
    const root = temporaryRoot()
    const binary = join(root, 'tiacore')
    symlinkSync(cli, binary)

    const commands = subcommands(run(binary, ['--help']))
    expect(commands).toEqual(expect.arrayContaining(['plan', 'k6', 'gradle']))
    expect(commands.filter((name) => name.includes(':'))).toEqual([])
    expect(subcommands(run(binary, ['k6', '--help']))).toEqual(
      expect.arrayContaining(['discover', 'record', 'plan']),
    )
    expect(run(binary, ['--version'])).toBe(`${manifest.version}\n`)
  })

  test('runs through a relative node_modules/.bin link', () => {
    const root = temporaryRoot()
    const bin = join(root, 'node_modules/.bin')
    mkdirSync(bin, { recursive: true })
    const binary = join(bin, 'tiacore')
    symlinkSync(relative(bin, cli), binary)

    expect(subcommands(run(binary, ['--help']))).toEqual(
      expect.arrayContaining(['plan', 'k6', 'gradle']),
    )
    expect(run(binary, ['--version'])).toBe(`${manifest.version}\n`)
  })
})
