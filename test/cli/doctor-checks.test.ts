import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, test } from 'vitest'

import {
  nodeCheck,
  runtimeChecks,
  selfCheck,
  writableCheck,
} from '../../src/cli/doctor-checks.ts'
import { summarizeSpans } from '../../src/cli/doctor-perf.ts'
import { renderDoctor } from '../../src/cli/doctor.ts'
import { satisfiesRange } from '../../src/cli/semver-range.ts'
import { NODE_ENGINES } from '../../src/core/version.ts'

const directories: string[] = []
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'tiacore-doctor-checks-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) {
    chmodSync(path, 0o755)
    rmSync(path, { force: true, recursive: true })
  }
})

const run = <A>(effect: Effect.Effect<A, never, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

describe('satisfiesRange', () => {
  test.each([
    ['22.12.0', '^22.12.0 || >=24.0.0', true],
    ['22.11.9', '^22.12.0 || >=24.0.0', false],
    ['23.0.0', '^22.12.0 || >=24.0.0', false],
    ['24.0.0', '^22.12.0 || >=24.0.0', true],
    ['v26.7.0', '^22.12.0 || >=24.0.0', true],
    ['4.1.0', '>=4.1.0 <6.0.0', true],
    ['5.0.5', '>=4.1.0 <6.0.0', true],
    ['6.0.0', '>=4.1.0 <6.0.0', false],
    ['4.0.9', '>=4.1.0 <6.0.0', false],
    ['1.64.1', '>=1.46.0 <2.0.0', true],
    ['5.0.0-beta.1', '>=4.1.0 <6.0.0', true],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '=1.2.3', false],
    ['1.2.3', '<=1.2.3', true],
    ['1.2.3', '>1.2.3', false],
  ])('%s against %s is %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected)
  })

  test('answers null for what it cannot read', () => {
    expect(satisfiesRange('not-a-version', '>=1.0.0')).toBeNull()
    expect(satisfiesRange('1.0.0', '>=1.x')).toBeNull()
    expect(satisfiesRange('1.0.0', 'latest')).toBeNull()
  })
})

describe('nodeCheck', () => {
  test('passes a supported version and fails an old one', () => {
    expect(nodeCheck('v22.12.0').status).toBe('ok')
    expect(nodeCheck('v22.11.0')).toMatchObject({
      detail: expect.stringContaining(NODE_ENGINES),
      status: 'fail',
    })
    expect(nodeCheck('v20.0.0').status).toBe('fail')
  })
})

describe('runtimeChecks', () => {
  test('reports Node.js when no Bun version is injected', () => {
    expect(runtimeChecks('v22.12.0', undefined)).toEqual([
      {
        detail: `v22.12.0 satisfies ${NODE_ENGINES}`,
        id: 'node',
        status: 'ok',
        title: 'Node.js',
      },
    ])
    expect(runtimeChecks('v22.12.0', '')).toEqual(
      runtimeChecks('v22.12.0', undefined),
    )
  })

  test('names Bun, then the Node.js compatibility engines check', () => {
    expect(runtimeChecks('v26.3.0', '1.4.4')).toEqual([
      {
        detail: `1.4.4 (Node.js compatibility v26.3.0). The Vitest plugin under Bun (bunx --bun vitest run) is best-effort: it records and replays, and @effect/vitest fiber attribution needs Node.js.`,
        id: 'bun',
        status: 'ok',
        title: 'Bun',
      },
      {
        detail: `v26.3.0 satisfies ${NODE_ENGINES}`,
        id: 'node',
        status: 'ok',
        title: 'Node.js compatibility',
      },
    ])
  })

  test('fails an unsupported Node.js compatibility version', () => {
    const node = runtimeChecks('v20.0.0', '1.4.4')[1]
    expect(node).toMatchObject({
      detail: expect.stringContaining('does not satisfy'),
      id: 'node',
      status: 'fail',
      title: 'Node.js compatibility',
    })
  })

  test('renders Bun ahead of the Node.js compatibility row', () => {
    const text = renderDoctor({
      checks: runtimeChecks('v26.3.0', '1.4.4'),
      ok: true,
      tiacore: '2.0.1',
    })
    expect(text).toContain('ok    Bun')
    expect(text).toContain('1.4.4 (Node.js compatibility v26.3.0)')
    expect(text).toContain(
      'The Vitest plugin under Bun (bunx --bun vitest run) is best-effort: it records and replays, and @effect/vitest fiber attribution needs Node.js.',
    )
    expect(text).toContain('ok    Node.js compatibility')
  })
})

describe('writableCheck', () => {
  test('accepts an existing writable directory', async () => {
    const root = scratch()
    expect(await run(writableCheck('cache', 'Cache', root))).toMatchObject({
      detail: `${root} is writable`,
      status: 'ok',
    })
  })

  test('judges a missing directory by its nearest parent and creates nothing', async () => {
    const root = scratch()
    const missing = join(root, 'a', 'b')
    expect(await run(writableCheck('cache', 'Cache', missing))).toMatchObject({
      detail: `${missing} does not exist yet; ${root} is writable`,
      status: 'ok',
    })
    expect(() => mkdirSync(join(root, 'a'))).not.toThrow()
  })

  test('fails when the nearest existing directory is read only', async () => {
    if (process.getuid?.() === 0) return
    const root = scratch()
    chmodSync(root, 0o555)
    expect(
      await run(writableCheck('cache', 'Cache', join(root, 'cache'))),
    ).toMatchObject({ detail: `${root} is not writable`, status: 'fail' })
  })
})

describe('selfCheck', () => {
  test('finds peers installed above the project and ignores damaged manifests', async () => {
    const root = scratch()
    const nested = join(root, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true })
    writeFileSync(
      join(root, 'node_modules', 'vitest', 'package.json'),
      '{"version":"3.9.0"}',
    )
    mkdirSync(join(root, 'node_modules', 'vite'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'vite', 'package.json'), '{oops')
    const checks = await run(
      selfCheck({
        bunVersion: undefined,
        cacheDir: '.tia',
        cwd: nested,
        env: {},
        nodeVersion: 'v22.12.0',
      }),
    )
    const byId = Object.fromEntries(checks.map((check) => [check.id, check]))
    expect(byId['peer:vitest']).toMatchObject({
      detail: expect.stringContaining('3.9.0 does not satisfy'),
      status: 'fail',
    })
    expect(byId['peer:vite']).toMatchObject({ status: 'info' })
    expect(byId['peer:@playwright/test']).toMatchObject({ status: 'info' })
  })

  test('lists the observability settings that are on', async () => {
    const checks = await run(
      selfCheck({
        bunVersion: undefined,
        cacheDir: '.tia',
        cwd: scratch(),
        env: { TIACORE_OTLP_URL: 'http://collector:4318' },
        nodeVersion: 'v22.12.0',
      }),
    )
    expect(checks.find((check) => check.id === 'observability')?.detail).toBe(
      'otlp=http://collector:4318',
    )
  })

  test('places an injected Bun version ahead of Node.js', async () => {
    const checks = await run(
      selfCheck({
        bunVersion: '1.4.4',
        cacheDir: '.tia',
        cwd: scratch(),
        env: {},
        nodeVersion: 'v26.3.0',
      }),
    )
    const ids = checks.map((check) => check.id)
    expect(ids.indexOf('bun')).toBe(ids.indexOf('tiacore') + 1)
    expect(ids.indexOf('node')).toBe(ids.indexOf('bun') + 1)
    expect(checks.find((check) => check.id === 'bun')).toMatchObject({
      detail: expect.stringContaining('1.4.4 (Node.js compatibility v26.3.0)'),
      status: 'ok',
      title: 'Bun',
    })
    expect(checks.find((check) => check.id === 'node')?.title).toBe(
      'Node.js compatibility',
    )
  })
})

const span = (name: string, durationMs: number) => ({
  attributes: {},
  durationMs,
  name,
  parentSpanId: null,
  spanId: 's',
  startUnixNanos: '0',
  status: 'success' as const,
  traceId: 't',
})

describe('summarizeSpans and renderDoctor', () => {
  test('groups spans by name, largest total first', () => {
    expect(
      summarizeSpans([
        span('a', 5),
        span('b', 20),
        span('a', 30),
        span('c', 35),
      ]),
    ).toEqual([
      { count: 2, maxMilliseconds: 30, name: 'a', totalMilliseconds: 35 },
      { count: 1, maxMilliseconds: 35, name: 'c', totalMilliseconds: 35 },
      { count: 1, maxMilliseconds: 20, name: 'b', totalMilliseconds: 20 },
    ])
  })

  test('renders failures so they are easy to find', () => {
    const text = renderDoctor({
      checks: [
        {
          detail: 'v20.0.0 does not satisfy ^22',
          id: 'node',
          status: 'fail',
          title: 'Node.js',
        },
        { detail: 'git version 2', id: 'git', status: 'ok', title: 'git' },
      ],
      ok: false,
      tiacore: '2.0.0',
    })
    expect(text).toContain('FAIL  Node.js')
    expect(text).toContain('ok    git')
    expect(text).toContain('Problems found.')
  })
})
