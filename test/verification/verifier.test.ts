import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { TiaVerifier, tia } from '../../src/entries/verification.ts'
import { execute } from '../../src/cli/main.ts'
import type {
  TiaVerificationPhase,
  TiaVerificationReceipt,
} from '../../src/core/verification.ts'
import { assertNoLeak } from '../support/leak.ts'
import { exampleSnapshot } from './support.ts'

// A stand-in for a TIA runner: it writes the snapshot files each phase's
// `<phase>.json` spec names, records the environment it saw, and exits with
// the spec's status.
const FAKE = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const phase = process.env.TIA_VERIFICATION_PHASE
const dir = process.env.TIA_VERIFICATION_DIRECTORY
appendFileSync('env.log', JSON.stringify({
  dir, fresh: process.env.TIA_FRESH ?? null, phase, argv: process.argv.slice(2),
}) + '\\n')
const spec = JSON.parse(readFileSync(phase + '.json', 'utf8'))
mkdirSync(join(dir, phase), { recursive: true })
for (const file of spec.files ?? []) {
  writeFileSync(join(dir, phase, file.name), typeof file.content === 'string' ? file.content : JSON.stringify(file.content))
}
process.exit(spec.status ?? 0)
`

interface Spec {
  files?: { content: unknown; name: string }[]
  status?: number
}

let root = ''
const temporary: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tiacore-verifier-'))
  temporary.push(root)
  await writeFile(join(root, 'fake.mjs'), FAKE)
})

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function phases(selective: Spec, full: Spec): Promise<void> {
  await writeFile(join(root, 'selective.json'), JSON.stringify(selective))
  await writeFile(join(root, 'full.json'), JSON.stringify(full))
}

const pair = (runner = 'vitest:fixture'): { full: Spec; selective: Spec } => ({
  full: {
    files: [
      { content: exampleSnapshot('full', undefined, runner), name: 'a.json' },
    ],
  },
  selective: {
    files: [
      {
        content: exampleSnapshot('selective', undefined, runner),
        name: 'a.json',
      },
    ],
  },
})

function environmentLog(): {
  argv: string[]
  dir: string
  fresh: string | null
  phase: TiaVerificationPhase
}[] {
  return readFileSync(join(root, 'env.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

const verifier = (extra: Record<string, unknown> = {}) =>
  new TiaVerifier({
    arguments: ['fake.mjs', '--flag value'],
    command: process.execPath,
    cwd: root,
    ...extra,
  })

describe('TiaVerifier', () => {
  test('rejects an empty command when constructed', () => {
    expect(() => tia({ command: '  ' })).toThrow(
      'TIA verification command cannot be empty',
    )
  })

  test('runs selective then full, passes argv through and removes its directory', async () => {
    const { full, selective } = pair()
    await phases(selective, full)
    const receipt = await verifier({ output: 'out/receipt.json' }).run()

    expect(receipt).toMatchObject({
      command: [process.execPath, 'fake.mjs', '--flag value'],
      schema: 2,
      success: true,
      verified: true,
    })
    const log = environmentLog()
    expect(log.map((entry) => entry.phase)).toEqual(['selective', 'full'])
    expect(log[0]?.argv).toEqual(['--flag value'])
    expect(log.map((entry) => entry.fresh)).toEqual([null, '1'])
    expect(log[0]?.dir).toBe(log[1]?.dir)
    expect(existsSync(log[0]?.dir ?? root)).toBe(false)
    expect(
      JSON.parse(readFileSync(join(root, 'out/receipt.json'), 'utf8')),
    ).toEqual(receipt)
    expect(readFileSync(join(root, 'out/receipt.json'), 'utf8')).toMatch(/\n$/u)
    expect(receipt.phases.full).toMatchObject({
      runners: ['vitest:fixture'],
      status: 0,
    })
  })

  test('an inherited TIA_FRESH does not reach the selective phase', async () => {
    const { full, selective } = pair()
    await phases(selective, full)
    process.env['TIA_FRESH'] = '1'
    try {
      await verifier({ environment: { TIA_FRESH: '1', KEEP: 'yes' } }).run()
    } finally {
      delete process.env['TIA_FRESH']
    }
    expect(environmentLog().map((entry) => entry.fresh)).toEqual([null, '1'])
  })

  test('a failing command is reported without unverifying the runner', async () => {
    const { full, selective } = pair()
    await phases({ ...selective, status: 3 }, { ...full, status: 130 })
    const receipt = await verifier().run()
    expect(receipt.verified).toBe(true)
    expect(receipt.success).toBe(false)
    expect(receipt.issues.map((issue) => issue.message)).toEqual([
      'selective command exited with status 3',
      'full command exited with status 130',
    ])
    expect(receipt.phases.selective.status).toBe(3)
  })

  test('no snapshots ends with snapshot-invalid', async () => {
    await phases({}, {})
    const receipt = await verifier().run()
    expect(receipt).toMatchObject({
      issues: [
        {
          code: 'snapshot-invalid',
          message: 'verification command did not produce any TIA snapshots',
        },
      ],
      runners: [],
      success: false,
      verified: false,
    })
  })

  test('a runner missing from one phase is unverified', async () => {
    const { full } = pair()
    await phases({}, full)
    const receipt = await verifier().run()
    expect(receipt.runners).toEqual([
      {
        issues: [
          {
            code: 'missing-selective-snapshot',
            message:
              'selective phase did not produce a snapshot for vitest:fixture',
            runner: 'vitest:fixture',
          },
        ],
        runner: 'vitest:fixture',
        selection: null,
        verified: false,
      },
    ])
    expect(receipt.verified).toBe(false)
  })

  test('a duplicate snapshot is reported and the first by name is compared', async () => {
    const { full, selective } = pair()
    const duplicate = {
      content: exampleSnapshot('selective', undefined),
      name: 'b.json',
    }
    await phases({ files: [...(selective.files ?? []), duplicate] }, full)
    const receipt = await verifier().run()
    expect(receipt.issues).toEqual([
      {
        code: 'duplicate-snapshot',
        message: 'phase produced more than one snapshot for vitest:fixture',
        runner: 'vitest:fixture',
      },
    ])
    expect(receipt.verified).toBe(false)
    expect(receipt.phases.selective.metrics).toHaveLength(2)
  })

  test('ignores files that are not .json', async () => {
    const { full, selective } = pair()
    await phases(
      {
        files: [
          ...(selective.files ?? []),
          { content: 'not json', name: 'a.json.tmp' },
        ],
      },
      full,
    )
    expect((await verifier().run()).verified).toBe(true)
  })

  test('an invalid snapshot rejects with its file name', async () => {
    const { full } = pair()
    await phases(
      {
        files: [
          {
            content: { ...exampleSnapshot('selective'), schema: 2 },
            name: 'bad.json',
          },
        ],
      },
      full,
    )
    await expect(verifier().run()).rejects.toThrow(
      'invalid TIA verification snapshot: bad.json',
    )
    await phases({ files: [{ content: '{nope', name: 'raw.json' }] }, full)
    await expect(verifier().run()).rejects.toThrow(/JSON|Expected/u)
  })

  test('a snapshot for the wrong phase is invalid', async () => {
    const { full } = pair()
    await phases(
      { files: [{ content: exampleSnapshot('full'), name: 'a.json' }] },
      full,
    )
    await expect(verifier().run()).rejects.toThrow(
      'invalid TIA verification snapshot: a.json',
    )
  })

  test('a spawn failure rejects and writes no receipt', async () => {
    await expect(
      new TiaVerifier({
        command: 'tiacore-no-such-command',
        cwd: root,
        output: 'receipt.json',
      }).run(),
    ).rejects.toThrow(/ENOENT/u)
    expect(existsSync(join(root, 'receipt.json'))).toBe(false)
  })

  test('an artifacts directory keeps the phase snapshots', async () => {
    const { full, selective } = pair()
    await phases(selective, full)
    await verifier({ artifactsDirectory: 'kept' }).run()
    const [run] = readdirSync(join(root, 'kept'))
    expect(run).toMatch(/^run-/u)
    expect(readdirSync(join(root, 'kept', run ?? '', 'selective'))).toEqual([
      'a.json',
    ])
    expect(readdirSync(join(root, 'kept', run ?? '', 'full'))).toEqual([
      'a.json',
    ])
  })

  test('keepArtifacts leaves the temporary directory', async () => {
    const { full, selective } = pair()
    await phases(selective, full)
    await verifier({ keepArtifacts: true }).run()
    const { dir } = environmentLog()[0] ?? { dir: '' }
    try {
      expect(existsSync(dir)).toBe(true)
      expect(dir).toContain('tiacore-verify-')
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  test('does not leak across repeated verifications in one process', async () => {
    const { full, selective } = pair()
    await phases(selective, full)
    const run = verifier()
    const { bytesPerOperation } = await assertNoLeak(() => run.run(), {
      batches: 3,
      bytesPerOperation: 20_000,
      iterations: 8,
    })
    expect(bytesPerOperation).toBeLessThan(20_000)
  }, 120_000)
})

const argv = (...extra: string[]) => [
  'verify',
  '--cwd',
  root,
  ...extra,
  '--',
  process.execPath,
  'fake.mjs',
  '--flag',
]

describe('tiacore verify', () => {
  test('writes the receipt and exits 0 when verified', async () => {
    const { full, selective } = pair()
    await phases(selective, full)
    const outcome = await execute(argv('--output', 'receipt.json'))
    expect(outcome).toEqual({ code: 0 })
    const receipt: TiaVerificationReceipt = JSON.parse(
      readFileSync(join(root, 'receipt.json'), 'utf8'),
    )
    expect(receipt.command).toEqual([process.execPath, 'fake.mjs', '--flag'])
    expect(environmentLog()[0]?.argv).toEqual(['--flag'])
  })

  test('exits 1 silently when the receipt reports failure', async () => {
    await phases({}, {})
    expect(await execute(argv('--output', 'receipt.json'))).toEqual({
      code: 1,
      silent: true,
    })
    expect(existsSync(join(root, 'receipt.json'))).toBe(true)
  })

  test('--artifacts keeps the snapshots', async () => {
    const { full, selective } = pair()
    await phases(selective, full)
    await execute(argv('--output', 'r.json', '--artifacts', 'snaps'))
    expect(readdirSync(join(root, 'snaps'))).toHaveLength(1)
  })

  test('an empty command fails', async () => {
    const outcome = await execute(['verify', '--', ''])
    expect(outcome).toEqual({
      code: 1,
      message: 'TIA verification command cannot be empty',
    })
  })
})
