import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  DEFAULT_TIA_EVIDENCE_HEADER,
  TIA_EVIDENCE_DIRECTORY_ENV,
  TIA_EVIDENCE_HEADER_ENV,
  TiaEvidence,
  tia,
} from '../../src/evidence/index.ts'
import { assertNoLeak } from '../support/leak.ts'
import { legacy } from '../support/legacy.ts'

const legacyEvidence = await legacy<{
  TiaEvidence: new (options: object) => TiaEvidence
}>('integrations/evidence/index.js')

const directories: string[] = []

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-evidence-'))
  directories.push(root)
  return root
}

function hashed(directory: string, id: string): string {
  return join(directory, createHash('sha256').update(id).digest('hex'))
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
  delete process.env[TIA_EVIDENCE_DIRECTORY_ENV]
  delete process.env[TIA_EVIDENCE_HEADER_ENV]
})

describe('evidence configuration', () => {
  test('defaults to <root>/.tia/evidence and the correlation header', () => {
    const root = project()
    const evidence = tia({ root })
    expect(evidence.directory).toBe(resolve(root, '.tia/evidence'))
    expect(evidence.header).toBe(DEFAULT_TIA_EVIDENCE_HEADER)
    expect(evidence.root).toBe(root)
    expect(evidence.producer).toBe(`${process.release.name}:${process.pid}`)
  })

  test('reads the directory and header from the environment, options first', () => {
    const root = project()
    process.env[TIA_EVIDENCE_DIRECTORY_ENV] = 'from-env'
    process.env[TIA_EVIDENCE_HEADER_ENV] = 'X-From-Env'
    expect(tia({ root }).directory).toBe(resolve(root, 'from-env'))
    expect(tia({ root }).header).toBe('x-from-env')
    expect(tia({ directory: 'option', header: 'X-Own', root }).directory).toBe(
      resolve(root, 'option'),
    )
  })

  test('treats an empty directory as the root itself (1.x quirk)', () => {
    const root = project()
    expect(tia({ directory: '', root }).directory).toBe(root)
    process.env[TIA_EVIDENCE_DIRECTORY_ENV] = ''
    expect(tia({ root }).directory).toBe(root)
  })
})

describe('correlation ids', () => {
  const evidence = new TiaEvidence({ root: tmpdir() })

  test.each(['a', 'A1._:-', 'x'.repeat(256)])('accepts %s', (id) => {
    expect(evidence.correlationId(id)).toBe(id)
  })

  test.each(['', 'x'.repeat(257), '../unsafe', 'a b', 'a/b', 'é'])(
    'rejects %j',
    (id) => {
      expect(() => evidence.correlationId(id)).toThrow(
        'TIA evidence correlation id is invalid',
      )
    },
  )

  test('generates a valid id when none is given', () => {
    expect(evidence.correlationId()).toMatch(/^[0-9a-f-]{36}$/u)
  })

  test('shares one process-wide store between instances', async () => {
    const other = new TiaEvidence({ root: tmpdir() })
    expect(evidence.currentCorrelationId()).toBeNull()
    await evidence.run('shared', async () => {
      await Promise.resolve()
      expect(other.currentCorrelationId()).toBe('shared')
      await new Promise((done) => setTimeout(done, 1))
      expect(evidence.currentCorrelationId()).toBe('shared')
    })
    expect(evidence.currentCorrelationId()).toBeNull()
    expect(() => evidence.run('bad id', () => 1)).toThrow(
      'TIA evidence correlation id is invalid',
    )
  })

  test('retains nothing per correlated run', async () => {
    const result = await assertNoLeak(
      () => evidence.run('leak', () => evidence.currentCorrelationId()),
      { bytesPerOperation: 32, iterations: 20_000 },
    )
    expect(result.bytesPerOperation).toBeLessThan(32)
  })

  test('keeps an id under the evidence directory by hashing it', async () => {
    const root = project()
    const writer = new TiaEvidence({ root })
    await writer.record(['src/a.ts'], 'a.b:c-d')
    expect(readdirSync(writer.directory)).toEqual([
      createHash('sha256').update('a.b:c-d').digest('hex'),
    ])
  })
})

describe('headers', () => {
  const evidence = new TiaEvidence({ header: 'X-Trace', root: tmpdir() })

  test('reads Fetch headers and plain objects, case-insensitively', () => {
    expect(evidence.fromHeaders(new Headers({ 'x-trace': 'one' }))).toBe('one')
    expect(evidence.fromHeaders({ 'X-TRACE': 'two' })).toBe('two')
    expect(evidence.fromHeaders({ 'x-trace': ['three', 'four'] })).toBe('three')
  })

  test('returns null for a missing, empty or invalid value without throwing', () => {
    expect(evidence.fromHeaders({})).toBeNull()
    expect(evidence.fromHeaders({ 'x-trace': [] })).toBeNull()
    expect(evidence.fromHeaders({ 'x-trace': '../unsafe' })).toBeNull()
    expect(evidence.fromHeaders(new Headers({ 'x-trace': 'a, b' }))).toBeNull()
  })

  test('builds the outgoing header and refuses an invalid id', () => {
    expect(evidence.headers('abc')).toEqual({ 'x-trace': 'abc' })
    expect(() => evidence.headers('a b')).toThrow('correlation id is invalid')
  })
})

describe('recording', () => {
  test('writes nothing without a correlation id', async () => {
    const root = project()
    const evidence = new TiaEvidence({ root })
    await evidence.record(['src/a.ts'])
    expect(() => readdirSync(evidence.directory)).toThrow('ENOENT')
    await expect(evidence.record(['src/a.ts'], 'bad id')).rejects.toThrow(
      'correlation id is invalid',
    )
  })

  test('normalizes, de-duplicates and sorts project files', async () => {
    const root = project()
    const evidence = new TiaEvidence({ root })
    await evidence.record(
      [
        'src/b.ts',
        join(root, 'src/a.ts'),
        'src/../src/b.ts',
        '../outside.ts',
        '.',
        root,
      ],
      'norm',
    )
    await expect(evidence.collect('norm')).resolves.toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
    await evidence.record(['../outside.ts', '.'], 'empty')
    expect(readdirSync(evidence.directory)).toHaveLength(1)
  })

  test('refuses an event with more than 1000 files', async () => {
    const evidence = new TiaEvidence({ root: project() })
    const many = Array.from({ length: 1001 }, (_, index) => `src/f${index}.ts`)
    await expect(evidence.record(many, 'many')).rejects.toThrow(
      'TIA evidence event contains too many files',
    )
    await expect(
      evidence.record(many.slice(0, 1000), 'many'),
    ).resolves.toBeUndefined()
  })

  test('writes one event file per record in the documented shape', async () => {
    const root = project()
    const evidence = new TiaEvidence({ producer: 'api', root })
    await evidence.record(['src/a.ts'], 'shape')
    await evidence.record(['src/a.ts'], 'shape')
    const directory = hashed(evidence.directory, 'shape')
    const names = readdirSync(directory)
    expect(names).toHaveLength(2)
    for (const name of names) {
      expect(name).toMatch(
        /^\d+-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u,
      )
      const text = readFileSync(join(directory, name), 'utf8')
      expect(text.endsWith('\n')).toBe(true)
      expect(JSON.parse(text)).toEqual({
        correlationId: 'shape',
        files: ['src/a.ts'],
        producedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        producer: 'api',
        schema: 1,
      })
    }
  })

  test('uses the correlation id of the running context', async () => {
    const evidence = new TiaEvidence({ root: project() })
    await evidence.run('ambient', () => evidence.record(['src/a.ts']))
    await expect(evidence.collect('ambient')).resolves.toEqual(['src/a.ts'])
  })

  test('interoperates with 1.x writers and readers', async () => {
    const root = project()
    const old = new legacyEvidence.TiaEvidence({ root })
    const current = new TiaEvidence({ root })
    await old.record(['src/old.ts'], 'mixed')
    await current.record(['src/new.ts'], 'mixed')
    await expect(current.collect('mixed')).resolves.toEqual([
      'src/new.ts',
      'src/old.ts',
    ])
    await expect(old.collect('mixed')).resolves.toEqual([
      'src/new.ts',
      'src/old.ts',
    ])
  })
})

function seed(evidence: TiaEvidence, id: string, name: string, text: string) {
  const directory = hashed(evidence.directory, id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), text)
}
const valid = (id: string, files: unknown) =>
  JSON.stringify({
    correlationId: id,
    files,
    producedAt: 'now',
    producer: 'p',
    schema: 1,
  })

describe('collecting', () => {
  test('returns [] for a missing, non-directory or symlinked directory', async () => {
    const root = project()
    const evidence = new TiaEvidence({ root })
    await expect(evidence.collect('none')).resolves.toEqual([])
    mkdirSync(evidence.directory, { recursive: true })
    writeFileSync(hashed(evidence.directory, 'file'), 'x')
    await expect(evidence.collect('file')).resolves.toEqual([])
    const real = join(root, 'real')
    mkdirSync(real)
    writeFileSync(join(real, '1.json'), valid('link', ['src/a.ts']))
    symlinkSync(real, hashed(evidence.directory, 'link'))
    await expect(evidence.collect('link')).resolves.toEqual([])
    await expect(evidence.collect('bad id')).rejects.toThrow(
      'correlation id is invalid',
    )
  })

  test('skips hostile and partial events silently', async () => {
    const evidence = new TiaEvidence({ root: project() })
    const id = 'hostile'
    seed(evidence, id, '1.json', valid(id, ['good.ts']))
    seed(
      evidence,
      id,
      '2.json',
      valid(id, ['x']).replace('"schema":1', '"schema":2'),
    )
    seed(evidence, id, '3.json', valid('other', ['wrong-id.ts']))
    seed(evidence, id, '4.json', valid(id, ['half.ts']).slice(0, 20))
    seed(
      evidence,
      id,
      '5.json',
      `${valid(id, ['big.ts'])}${' '.repeat(1024 * 1024)}`,
    )
    seed(evidence, id, '6.txt', valid(id, ['text.ts']))
    seed(evidence, id, '7.json', valid(id, [1]))
    seed(
      evidence,
      id,
      '8.json',
      valid(
        id,
        Array.from({ length: 1001 }, (_, i) => `f${i}`),
      ),
    )
    seed(
      evidence,
      id,
      '9.json',
      JSON.stringify({ ...JSON.parse(valid(id, [])), producer: 3 }),
    )
    await expect(evidence.collect(id)).resolves.toEqual(['good.ts'])
  })

  test('reports a collection complete when every event was read', async () => {
    const evidence = new TiaEvidence({ root: project() })
    await expect(evidence.collectChecked('none')).resolves.toEqual({
      complete: true,
      files: [],
    })
    await evidence.record(['src/a.ts'], 'clean')
    await evidence.record(['src/b.ts'], 'clean')
    await expect(evidence.collectChecked('clean')).resolves.toEqual({
      complete: true,
      files: ['src/a.ts', 'src/b.ts'],
    })
    expect(
      readdirSync(hashed(evidence.directory, 'clean')).filter(
        (name) => !name.endsWith('.json'),
      ),
    ).toEqual([])
  })

  test.each([
    [
      'a partial event',
      '2.json',
      (id: string) => valid(id, ['b.ts']).slice(0, 20),
    ],
    [
      'an event still being written',
      '2.tmp',
      (id: string) => valid(id, ['b.ts']),
    ],
    ['an invalid event', '2.json', (id: string) => valid(id, [1])],
    [
      'an oversized event',
      '2.json',
      (id: string) => `${valid(id, ['b.ts'])}${' '.repeat(1024 * 1024)}`,
    ],
  ])('reports a collection incomplete after %s', async (_, name, text) => {
    const evidence = new TiaEvidence({ root: project() })
    const id = 'lossy'
    seed(evidence, id, '1.json', valid(id, ['a.ts']))
    seed(evidence, id, name, text(id))
    await expect(evidence.collectChecked(id)).resolves.toEqual({
      complete: false,
      files: ['a.ts'],
    })
  })

  test('reports a collection incomplete past the event bound', async () => {
    const evidence = new TiaEvidence({ root: project() })
    const id = 'over'
    const directory = hashed(evidence.directory, id)
    mkdirSync(directory, { recursive: true })
    for (let index = 0; index < 10_001; index += 1) {
      writeFileSync(
        join(directory, `${String(index).padStart(6, '0')}.json`),
        valid(id, [`f${index}.ts`]),
      )
    }
    expect((await evidence.collectChecked(id)).complete).toBe(false)
  })

  test('reads at most 10000 events, oldest names first', async () => {
    const evidence = new TiaEvidence({ root: project() })
    const id = 'capped'
    const directory = hashed(evidence.directory, id)
    mkdirSync(directory, { recursive: true })
    for (let index = 0; index < 10_001; index += 1) {
      const name = `${String(index).padStart(6, '0')}.json`
      writeFileSync(join(directory, name), valid(id, [`f${index}.ts`]))
    }
    const files = await evidence.collect(id)
    expect(files).toHaveLength(10_000)
    expect(files).not.toContain('f10000.ts')
    expect(files).toContain('f9999.ts')
  })

  test('returns stored file strings without containment checks', async () => {
    const evidence = new TiaEvidence({ root: project() })
    seed(
      evidence,
      'raw',
      '1.json',
      valid('raw', ['../../etc/passwd', '/abs.ts']),
    )
    await expect(evidence.collect('raw')).resolves.toEqual([
      '../../etc/passwd',
      '/abs.ts',
    ])
  })

  test('removes the directory when asked', async () => {
    const evidence = new TiaEvidence({ root: project() })
    await evidence.record(['src/a.ts'], 'gone')
    await expect(evidence.collect('gone', { remove: true })).resolves.toEqual([
      'src/a.ts',
    ])
    await expect(evidence.collect('gone')).resolves.toEqual([])
  })
})
