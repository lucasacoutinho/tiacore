import { randomBytes } from 'node:crypto'

import { strToU8, zipSync } from 'fflate'
import { describe, expect, test } from 'vitest'

import {
  MAX_ARCHIVE_ENTRIES,
  MAX_NESTED_ARCHIVES,
  readArtifactArchive,
} from '../../src/engine/artifacts/archive.ts'
import { graph, sha256 } from './support.ts'

// ART-ZIP-01..15: the exact-name allowlist, the size limits and the nesting rule.

const json = (value: unknown) => strToU8(JSON.stringify(value))
const NESTED = 'tiacore-0123456789abcdef01234567.zip'

describe('reading an archive', () => {
  test('selects runner paths in order and never falls back to the bare graph', () => {
    const bare = zipSync({ 'graph.json': json(graph('bare')) })
    expect(readArtifactArchive(bare, undefined)?.graph.fingerprint).toBe('bare')
    expect(readArtifactArchive(bare, 'node')).toBeNull()
    const dot = zipSync({ '.tia/graph.json': json(graph('dot')) })
    expect(readArtifactArchive(dot, undefined)?.graph.fingerprint).toBe('dot')
    const both = zipSync({
      '.tia/node/graph.json': json(graph('hidden')),
      'node/graph.json': json(graph('plain')),
    })
    expect(readArtifactArchive(both, 'node')?.graph.fingerprint).toBe('plain')
    const hidden = zipSync({ '.tia/node/graph.json': json(graph('hidden')) })
    expect(readArtifactArchive(hidden, 'node')?.graph.fingerprint).toBe(
      'hidden',
    )
  })

  test('the digest covers the raw entry bytes and the attestation follows the runner order', () => {
    const raw = strToU8(`${JSON.stringify(graph('digest'))}\n\n`)
    const attestation = (keyId: string) => ({
      algorithm: 'Ed25519',
      claim: {
        expiresAt: '2030-01-01T00:00:00.000Z',
        fingerprint: 'digest',
        graphSha256: sha256(raw),
        issuedAt: '2026-01-01T00:00:00.000Z',
        lineage: {
          baseline: { sha: 'abc' },
          parents: [],
          producedAt: '2026-01-01T00:00:00.000Z',
          runId: 'r',
        },
        promoted: false,
      },
      keyId,
      signature: 'A'.repeat(86),
      version: 1,
    })
    const archive = zipSync({
      'attestation.json': json(attestation('bare')),
      'node/attestation.json': json(attestation('namespaced')),
      'node/graph.json': raw,
    })
    const read = readArtifactArchive(archive, 'node')
    expect(read?.graphSha256).toBe(sha256(raw))
    expect(read?.attestation?.keyId).toBe('namespaced')
  })

  test('a malformed attestation leaves the graph without one', () => {
    for (const bad of [strToU8('not json'), json({ version: 1 }), json(null)]) {
      const archive = zipSync({
        'attestation.json': bad,
        'graph.json': json(graph('unsigned')),
      })
      const read = readArtifactArchive(archive, undefined)
      expect(read?.graph.fingerprint).toBe('unsigned')
      expect(read?.attestation).toBeUndefined()
    }
  })

  test('an unparsable graph falls through to the next path and then to a nested archive', () => {
    const fallthrough = zipSync({
      '.tia/graph.json': json(graph('second')),
      'graph.json': strToU8('{"broken"'),
    })
    expect(readArtifactArchive(fallthrough, undefined)?.graph.fingerprint).toBe(
      'second',
    )
    const nested = zipSync({
      [NESTED]: zipSync({ 'graph.json': json(graph('inner')) }),
      'graph.json': strToU8('nope'),
    })
    expect(readArtifactArchive(nested, undefined)?.graph.fingerprint).toBe(
      'inner',
    )
  })

  test('returns null for a corrupt, empty or oversized archive', () => {
    expect(readArtifactArchive(strToU8('not a zip'), undefined)).toBeNull()
    expect(readArtifactArchive(new Uint8Array(), undefined)).toBeNull()
    expect(
      readArtifactArchive(new Uint8Array(25 * 1024 * 1024 + 1), undefined),
    ).toBeNull()
    const truncated = zipSync({ 'graph.json': json(graph('x')) }).slice(0, 40)
    expect(readArtifactArchive(truncated, undefined)).toBeNull()
  })

  test('nests exactly one level and ignores decoy archives when the top level has a graph', () => {
    const inner = zipSync({ 'graph.json': json(graph('inner')) })
    const twice = zipSync({ [NESTED]: zipSync({ [NESTED]: inner }) })
    expect(readArtifactArchive(twice, undefined)).toBeNull()
    const decoy = zipSync({
      'graph.json': json(graph('top')),
      [NESTED]: new Uint8Array(19 * 1024 * 1024).fill(7),
    })
    expect(readArtifactArchive(decoy, undefined)?.graph.fingerprint).toBe('top')
    const unnamed = zipSync({ 'other.zip': inner })
    expect(readArtifactArchive(unnamed, undefined)).toBeNull()
  })
})

const padded = (bytes: number) =>
  strToU8(`${JSON.stringify(graph('padded'))}${' '.repeat(bytes)}`)

describe('expansion limits', () => {
  test('an entry that expands past the ratio limit is refused, a modest one is read', () => {
    const bomb = zipSync({ 'graph.json': padded(4 * 1024 * 1024) })
    expect(bomb.byteLength).toBeLessThan(10 * 1024)
    expect(readArtifactArchive(bomb, undefined)).toBeNull()
    const small = zipSync({ 'graph.json': padded(512 * 1024) })
    expect(readArtifactArchive(small, undefined)?.graph.fingerprint).toBe(
      'padded',
    )
  })

  test('an entry declaring more than 20 MiB is never inflated', () => {
    const big = zipSync({ 'graph.json': padded(21 * 1024 * 1024) })
    expect(readArtifactArchive(big, undefined)).toBeNull()
  })

  test('refuses too many nested archives and too much total expansion', () => {
    const noise = randomBytes(1024)
    const pattern = (length: number) => {
      const out = new Uint8Array(length)
      for (let offset = 0; offset < length; offset += noise.length) {
        out.set(
          noise.subarray(0, Math.min(noise.length, length - offset)),
          offset,
        )
      }
      return out
    }
    const many = Object.fromEntries(
      Array.from({ length: MAX_NESTED_ARCHIVES + 1 }, (_, index) => [
        `tiacore-${String(index).padStart(24, '0')}.zip`,
        strToU8('x'),
      ]),
    )
    expect(readArtifactArchive(zipSync(many), undefined)).toBeNull()
    const heavy = Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [
        `tiacore-${String(index).padStart(24, '0')}.zip`,
        pattern(17 * 1024 * 1024),
      ]),
    )
    const archive = zipSync(heavy)
    expect(archive.byteLength).toBeLessThan(25 * 1024 * 1024)
    expect(readArtifactArchive(archive, undefined)).toBeNull()
  })

  test('refuses an archive listing more entries than the limit', () => {
    const entries = Object.fromEntries(
      Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, index) => [
        `f${index}`,
        new Uint8Array(),
      ]),
    )
    entries['graph.json'] = json(graph('many'))
    expect(readArtifactArchive(zipSync(entries), undefined)).toBeNull()
  })

  test('never inflates an entry outside the allowlist, even with an unsupported method', () => {
    const archive = zipSync({
      'graph.json': json(graph('current')),
      'unsupported.bin': strToU8('ignored'),
    })
    const signature = [0x50, 0x4b, 0x01, 0x02]
    for (let index = 0; index < archive.length - 4; index += 1) {
      if (
        !signature.every((value, offset) => archive[index + offset] === value)
      ) {
        continue
      }
      const length = archive[index + 28]! | (archive[index + 29]! << 8)
      const name = new TextDecoder().decode(
        archive.slice(index + 46, index + 46 + length),
      )
      if (name === 'unsupported.bin') {
        archive[index + 10] = 99
        archive[index + 11] = 0
      }
    }
    expect(readArtifactArchive(archive, undefined)?.graph.fingerprint).toBe(
      'current',
    )
  })
})
