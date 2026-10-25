import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Synchronous scratch projects for baseline tests. The oracle (1.x) is
// synchronous too, so a scenario is built once and both sides read it.

const created: string[] = []

export function scratch(prefix = 'tia-base-'): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  created.push(directory)
  return directory
}

export function cleanupScratch(): void {
  for (const directory of created.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
}

export function vcs(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function put(root: string, file: string, content = `${file}\n`): void {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), content)
}

export function init(root: string): void {
  vcs(root, 'init', '-q', '-b', 'main')
  vcs(root, 'config', 'user.email', 'tia@example.test')
  vcs(root, 'config', 'user.name', 'TIA')
  vcs(root, 'config', 'protocol.file.allow', 'always')
}

export function commit(root: string, message = 'commit'): string {
  vcs(root, 'add', '-A')
  vcs(root, 'commit', '-q', '--allow-empty', '-m', message)
  return vcs(root, 'rev-parse', 'HEAD')
}

/** A repository with the given files committed. */
export function repository(files: Record<string, string>): string {
  const root = scratch()
  init(root)
  for (const [file, content] of Object.entries(files)) put(root, file, content)
  commit(root, 'baseline')
  return root
}
