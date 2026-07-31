import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  archiveGraph,
  createGitHubActionsArtifactProvider,
  readBoundedResponse,
} from '../../../src/engine/artifacts/github-actions.js'
import { restoreGraphFromArtifacts } from '../../../src/engine/artifacts/restore.js'
import {
  graphPath,
  readGraph,
  writeGraph,
} from '../../../src/engine/state/store.js'
import type { TiaRuntimeGraph } from '../../../src/shared/types.js'

const temporaryDirectories: string[] = []

function graph(fingerprint: string): TiaRuntimeGraph {
  return {
    baseline: { sha: 'abc', workingTree: {} },
    collectionCoverage: {},
    complete: true,
    coverageComplete: true,
    edges: { 'test/a.test.ts': ['src/a.ts', 'test/a.test.ts'] },
    fingerprint,
    results: {
      a: {
        file: 'test/a.test.ts',
        fullName: 'a',
        id: 'a',
        state: 'passed',
      },
    },
    schema: 3,
    testCoverage: {},
    testEdges: {
      a: {
        file: 'test/a.test.ts',
        files: ['src/a.ts', 'test/a.test.ts'],
      },
    },
    updatedAt: new Date(0).toISOString(),
  }
}

function options(
  value: Parameters<typeof createGitHubActionsArtifactProvider>[0] = {},
): Parameters<typeof createGitHubActionsArtifactProvider>[0] {
  return {
    apiUrl: 'https://api.github.test',
    artifactName: 'tiacore',
    maxArtifacts: 20,
    repository: 'owner/repo',
    tokenEnv: 'TIACORE_TEST_TOKEN',
    ...value,
  }
}

function cacheDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-artifacts-'))
  temporaryDirectories.push(root)
  return join(root, '.tia')
}

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(
    body instanceof Uint8Array ? body : JSON.stringify(body),
    init,
  )
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('GitHub Actions artifact discovery', () => {
  test('stops reading a streamed archive at the byte limit', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.enqueue(new Uint8Array([4, 5, 6]))
      },
    })

    await expect(
      readBoundedResponse(new Response(body), 4),
    ).resolves.toBeNull()
    expect(cancelled).toBe(true)
  })

  test('extracts only graph entries from an archive', () => {
    const archive = zipSync({
      'graph.json': strToU8(JSON.stringify(graph('current'))),
      'unsupported.bin': strToU8('ignored'),
    })
    const centralSignature = [0x50, 0x4b, 0x01, 0x02]
    for (let index = 0; index < archive.length - 4; index += 1) {
      if (
        centralSignature.every(
          (value, offset) => archive[index + offset] === value,
        )
      ) {
        const nameLength =
          archive[index + 28]! | (archive[index + 29]! << 8)
        const name = strFromBytes(
          archive.slice(index + 46, index + 46 + nameLength),
        )
        if (name === 'unsupported.bin') {
          archive[index + 10] = 99
          archive[index + 11] = 0
          break
        }
      }
    }

    expect(archiveGraph(archive, undefined)?.fingerprint).toBe('current')
  })

  test('restores the newest compatible graph without extracting other files', async () => {
    vi.stubEnv('TIACORE_TEST_TOKEN', 'test-token')
    const incompatible = zipSync({
      'graph.json': strToU8(JSON.stringify(graph('old'))),
    })
    const compatible = zipSync({
      '../outside.txt': strToU8('must never be written'),
      'graph.json': strToU8(JSON.stringify(graph('current'))),
    })
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          artifacts: [
            {
              archive_download_url: 'https://download.test/new',
              created_at: '2026-07-29T12:00:00Z',
              expired: false,
              id: 2,
              name: 'tiacore-new',
              size_in_bytes: incompatible.byteLength,
              workflow_run: { head_branch: 'main', id: 20 },
            },
            {
              archive_download_url: 'https://download.test/old',
              created_at: '2026-07-28T12:00:00Z',
              expired: false,
              id: 1,
              name: 'tiacore-old',
              size_in_bytes: compatible.byteLength,
              workflow_run: { head_branch: 'main', id: 10 },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response(incompatible))
      .mockResolvedValueOnce(response(compatible))
    const target = cacheDir()

    const result = await restoreGraphFromArtifacts({
      cacheDir: target,
      fingerprint: 'current',
      log: false,
      providers: [
        createGitHubActionsArtifactProvider(
          options({ artifactName: 'tiacore-*', branch: 'main' }),
          request,
        ),
      ],
    })

    expect(result).toEqual({
      artifactId: 1,
      provider: 'GitHub Actions',
      reason: 'compatible artifact restored',
      restored: true,
      trust: {
        reason: 'unsigned artifacts explicitly allowed',
      },
    })
    expect(JSON.parse(readFileSync(graphPath(target), 'utf8'))).toMatchObject({
      fingerprint: 'current',
    })
    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://api.github.test/repos/owner/repo/actions/artifacts?per_page=100',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    )
  })

  test('finds a runner-namespaced graph in an exact workflow run', async () => {
    const archive = zipSync({
      'node/graph.json': strToU8(JSON.stringify(graph('node-current'))),
    })
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          artifacts: [
            {
              archive_download_url: 'https://download.test/node',
              created_at: '2026-07-29T12:00:00Z',
              expired: false,
              id: 7,
              name: 'tiacore',
              size_in_bytes: archive.byteLength,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response(archive))

    const result = await restoreGraphFromArtifacts({
      cacheDir: cacheDir(),
      fingerprint: 'node-current',
      log: false,
      providers: [
        createGitHubActionsArtifactProvider(
          options({ runId: '99' }),
          request,
        ),
      ],
      runner: 'node',
    })

    expect(result.restored).toBe(true)
    expect(request.mock.calls[0]?.[0]).toContain(
      '/actions/runs/99/artifacts?name=tiacore',
    )
  })

  test('fails closed when configuration, API data, or archives are invalid', async () => {
    const target = cacheDir()
    const noRepository = await restoreGraphFromArtifacts({
      cacheDir: target,
      fingerprint: 'current',
      log: false,
      providers: [
        createGitHubActionsArtifactProvider(
          options({ repository: 'not-a-repository' }),
          vi.fn(),
        ),
      ],
    })
    expect(noRepository.restored).toBe(false)

    const request = vi.fn<typeof fetch>().mockResolvedValue(
      response({ message: 'rate limited' }, { status: 403 }),
    )
    const unavailable = await restoreGraphFromArtifacts({
      cacheDir: target,
      fingerprint: 'current',
      log: false,
      providers: [
        createGitHubActionsArtifactProvider(options(), request),
      ],
    })
    expect(unavailable).toEqual({
      reason: 'no provider returned a compatible artifact',
      restored: false,
    })
  })

  test('supports a non-GitHub provider through the shared contract', async () => {
    const target = cacheDir()
    const result = await restoreGraphFromArtifacts({
      cacheDir: target,
      fingerprint: 'portable',
      log: false,
      providers: [
        {
          name: 'object storage',
          async load(context) {
            expect(context).toEqual({ fingerprint: 'portable' })
            return {
              graph: JSON.stringify(graph('portable')),
              id: 'bucket/build-42',
            }
          },
        },
      ],
    })

    expect(result).toMatchObject({
      artifactId: 'bucket/build-42',
      provider: 'object storage',
      restored: true,
    })
    expect(JSON.parse(readFileSync(graphPath(target), 'utf8'))).toMatchObject({
      fingerprint: 'portable',
    })
  })

  test('preserves a graph committed while an artifact provider is loading', async () => {
    const target = cacheDir()
    let release:
      | ((value: {
          graph: TiaRuntimeGraph
          id: string
        }) => void)
      | undefined
    const loading = new Promise<{
      graph: TiaRuntimeGraph
      id: string
    }>((resolve) => {
      release = resolve
    })
    const restoring = restoreGraphFromArtifacts({
      cacheDir: target,
      fingerprint: 'artifact',
      log: false,
      providers: [{
        name: 'delayed storage',
        load: () => loading,
      }],
    })

    writeGraph(target, graph('local-writer'))
    release?.({
      graph: graph('artifact'),
      id: 'delayed-artifact',
    })

    await expect(restoring).resolves.toEqual({
      reason: 'concurrent graph update prevented artifact restore',
      restored: false,
    })
    expect(readGraph(target)?.fingerprint).toBe('local-writer')
  })

  test('continues to a later provider after a provider throws', async () => {
    const target = cacheDir()
    const result = await restoreGraphFromArtifacts({
      cacheDir: target,
      fingerprint: 'fallback',
      log: false,
      providers: [
        {
          name: 'unavailable storage',
          load() {
            throw new Error('injected provider failure')
          },
        },
        {
          name: 'fallback storage',
          async load() {
            return {
              graph: graph('fallback'),
              id: 'fallback-artifact',
            }
          },
        },
      ],
    })

    expect(result).toMatchObject({
      artifactId: 'fallback-artifact',
      provider: 'fallback storage',
      restored: true,
    })
    expect(readGraph(target)?.fingerprint).toBe('fallback')
  })

  test('replaces an incomplete local graph from a provider', async () => {
    const target = cacheDir()
    const incomplete = graph('current')
    incomplete.complete = false
    writeGraph(target, incomplete)
    const load = vi.fn(async () => ({
      graph: graph('current'),
      id: 'complete-artifact',
    }))

    const result = await restoreGraphFromArtifacts({
      cacheDir: target,
      fingerprint: 'current',
      log: false,
      providers: [{ load, name: 'complete storage' }],
    })

    expect(result.restored).toBe(true)
    expect(load).toHaveBeenCalledOnce()
    expect(readGraph(target)?.complete).toBe(true)
  })

  test('replaces coverage-incomplete local graphs when coverage is requested', async () => {
    const target = cacheDir()
    const incomplete = graph('current')
    incomplete.coverageComplete = false
    writeGraph(target, incomplete)
    const load = vi.fn(async () => ({
      graph: graph('current'),
      id: 'coverage-artifact',
    }))

    const result = await restoreGraphFromArtifacts({
      cacheDir: target,
      coverageRequested: true,
      fingerprint: 'current',
      log: false,
      providers: [{ load, name: 'coverage storage' }],
    })

    expect(result.restored).toBe(true)
    expect(load).toHaveBeenCalledOnce()
    expect(readGraph(target)?.coverageComplete).toBe(true)
  })
})

function strFromBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
