import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, bench } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(packageRoot, 'test/fixtures/parallel-vitest')
const vitest = join(packageRoot, 'node_modules/vitest/vitest.mjs')

function clean(): void {
  for (const path of ['.tia', 'executions.log', 'node_modules', 'spans']) {
    rmSync(join(fixture, path), {
      force: true,
      recursive: true,
    })
  }
}

function run(pool: 'forks' | 'threads', workers: number): void {
  clean()
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--root',
      fixture,
      '--config',
      join(fixture, 'vitest.benchmark.config.ts'),
      `--pool=${pool}`,
      `--maxWorkers=${workers}`,
    ],
    {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        TIA_FRESH: '1',
      },
      timeout: 30_000,
    },
  )
  if (result.status !== 0) {
    throw new Error(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
}

const options = {
  iterations: 1,
  time: 0,
  warmupIterations: 0,
  warmupTime: 0,
}

bench('threads with 1 worker', () => run('threads', 1), options)
bench('threads with 4 workers', () => run('threads', 4), options)
bench('forks with 1 worker', () => run('forks', 1), options)
bench('forks with 4 workers', () => run('forks', 4), options)

afterAll(clean)
