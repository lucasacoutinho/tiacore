import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import {
  SOURCE_MAP_CACHE_LIMIT,
  clearSourceMapCaches,
  coveredSourceMapFiles,
  sourceMapCacheSize,
  sourceMapFiles,
} from '../../src/runners/playwright/source-maps.ts'
import { assertNoLeak } from '../support/leak.ts'

// Spelled in pieces so the test runner does not treat them as this file's own map.
const DIRECTIVE = ['//#', 'sourceMappingURL='].join(' ')
const BLOCK = ['/*#', 'sourceMappingURL='].join(' ')

const roots: string[] = []

afterEach(() => {
  clearSourceMapCaches()
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-playwright-map-'))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

function dataMap(map: object): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`
}

const everything = (script: string) => [
  { ranges: [{ count: 1, endOffset: script.length, startOffset: 0 }] },
]

const section = (source: string) => ({
  mappings: 'AAAA',
  names: [],
  sourceRoot: 'src',
  sources: [source],
  version: 3,
})

const mapJson = (sources: string[], extra: object = {}) =>
  JSON.stringify({ mappings: '', names: [], sources, version: 3, ...extra })

const attribute = async (root: string, source: string, base?: string) => {
  const script = `a();\n${DIRECTIVE}${dataMap({ mappings: 'AAAA', names: [], sources: [source], version: 3 })}`
  return coveredSourceMapFiles(
    base ?? 'http://fixture.test/x.js',
    script,
    everything(script),
    root,
  )
}

test('maps only executed generated ranges to their original files', async () => {
  const root = project({
    'src/a.ts': 'export const a = 1\n',
    'src/b.ts': 'export const b = 2\n',
  })
  const map = Buffer.from(
    JSON.stringify({
      mappings: 'AAAA;ACAA',
      names: [],
      sources: ['src/a.ts', 'src/b.ts'],
      version: 3,
    }),
  ).toString('base64')
  const script = `a();\nb();\n${DIRECTIVE}data:application/json;base64,${map}`

  await expect(
    coveredSourceMapFiles(
      'http://fixture.test/bundle.js',
      script,
      [
        {
          ranges: [{ count: 1, endOffset: script.length, startOffset: 0 }],
        },
        { ranges: [{ count: 0, endOffset: 9, startOffset: 5 }] },
      ],
      root,
    ),
  ).resolves.toEqual(['src/a.ts'])
})

describe('executed-range attribution', () => {
  const sources = {
    'src/a.ts': 'a\n',
    'src/b.ts': 'b\n',
  }
  const mappings = { mappings: 'AAAA;ACAA', names: [], version: 3 }

  test('the innermost range decides, and a tie goes to the smaller count', async () => {
    const root = project(sources)
    const script = `a();\nb();\n${DIRECTIVE}${dataMap({ ...mappings, sources: ['src/a.ts', 'src/b.ts'] })}`
    // b() sits at offsets 5..9 and is nested inside the covered whole script.
    const nested = await coveredSourceMapFiles(
      'http://fixture.test/x.js',
      script,
      [
        ...everything(script),
        { ranges: [{ count: 0, endOffset: 9, startOffset: 5 }] },
        { ranges: [{ count: 3, endOffset: 4, startOffset: 0 }] },
      ],
      root,
    )
    expect(nested).toEqual(['src/a.ts'])

    const tied = await coveredSourceMapFiles(
      'http://fixture.test/x.js',
      script,
      [
        { ranges: [{ count: 2, endOffset: 4, startOffset: 0 }] },
        { ranges: [{ count: 0, endOffset: 4, startOffset: 0 }] },
      ],
      root,
    )
    expect(tied).toEqual([])
  })

  test('ranges that start below zero or end where they start are ignored', async () => {
    const root = project(sources)
    const script = `a();\nb();\n${DIRECTIVE}${dataMap({ ...mappings, sources: ['src/a.ts', 'src/b.ts'] })}`
    await expect(
      coveredSourceMapFiles(
        'http://fixture.test/x.js',
        script,
        [
          {
            ranges: [
              { count: 1, endOffset: 4, startOffset: -3 },
              { count: 1, endOffset: 5, startOffset: 5 },
            ],
          },
        ],
        root,
      ),
    ).resolves.toEqual([])
  })

  test('line offsets split on LF only', async () => {
    const root = project(sources)
    // A CR in line one does not start a new line, so b() stays on line two.
    const script = `a();\rx;\nb();\n${DIRECTIVE}${dataMap({ ...mappings, sources: ['src/a.ts', 'src/b.ts'] })}`
    const bStart = script.indexOf('b();')
    await expect(
      coveredSourceMapFiles(
        'http://fixture.test/x.js',
        script,
        [
          {
            ranges: [{ count: 1, endOffset: bStart + 4, startOffset: bStart }],
          },
        ],
        root,
      ),
    ).resolves.toEqual(['src/b.ts'])
  })

  test('indexed maps and sourceRoot are applied by the map library', async () => {
    const root = project(sources)
    const script = `a();\nb();\n${DIRECTIVE}${dataMap({
      sections: [
        { map: section('a.ts'), offset: { column: 0, line: 0 } },
        { map: section('b.ts'), offset: { column: 0, line: 1 } },
      ],
      version: 3,
    })}`
    await expect(
      coveredSourceMapFiles(
        'http://fixture.test/x.js',
        script,
        everything(script),
        root,
      ),
    ).resolves.toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('a script served from the project counts only when something ran', async () => {
    const root = project({ 'public/app.js': 'x\n' })
    const script = 'x();\n'
    await expect(
      coveredSourceMapFiles(
        'http://fixture.test/public/app.js',
        script,
        [{ ranges: [{ count: 0, endOffset: 5, startOffset: 0 }] }],
        root,
      ),
    ).resolves.toEqual([])
    await expect(
      coveredSourceMapFiles(
        'http://fixture.test/public/app.js',
        script,
        everything(script),
        root,
      ),
    ).resolves.toEqual(['public/app.js'])
  })

  test('an invalid map degrades to the script path', async () => {
    const root = project({ 'public/app.js': 'x\n' })
    const script = `x();\n${DIRECTIVE}data:application/json,not-json`
    await expect(
      coveredSourceMapFiles(
        'http://fixture.test/public/app.js',
        script,
        everything(script),
        root,
      ),
    ).resolves.toEqual(['public/app.js'])
  })
})

describe('whole-script attribution over HTTP', () => {
  let server: Server
  let origin = ''
  const requests: string[] = []
  const routes = new Map<
    string,
    { body: string; headers?: Record<string, string>; status?: number }
  >()

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? ''
      requests.push(path)
      const route = routes.get(path.split('?')[0] ?? '')
      if (route === undefined) {
        response.writeHead(404)
        response.end()
        return
      }
      response.writeHead(route.status ?? 200, route.headers ?? {})
      response.end(route.body)
    })
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((closed) => server.close(closed))
  })
  afterEach(() => {
    routes.clear()
    requests.length = 0
  })

  test('reads each directive form, only at the end of the script', async () => {
    const root = project({ 'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '' })
    routes.set('/a.js', {
      body: `a();\n${DIRECTIVE}a.js.map`,
    })
    routes.set('/a.js.map', { body: mapJson(['src/a.ts']) })
    routes.set('/b.js', {
      body: `b();\n${BLOCK}b.map */\n`,
    })
    routes.set('/b.map', { body: mapJson(['src/b.ts']) })
    routes.set('/c.js', {
      body: `${DIRECTIVE}other.map\nc();`,
    })
    routes.set('/c.map', { body: mapJson(['src/c.ts']) })

    await expect(sourceMapFiles(`${origin}/a.js`, root)).resolves.toEqual([
      'src/a.ts',
    ])
    await expect(sourceMapFiles(`${origin}/b.js`, root)).resolves.toEqual([
      'src/b.ts',
    ])
    // The directive in the middle is not at the end, so the suffix guess wins.
    await expect(sourceMapFiles(`${origin}/c.js`, root)).resolves.toEqual([
      'src/c.ts',
    ])
  })

  test('guesses the map from the suffix and skips the download of a bundle', async () => {
    const root = project({ 'src/a.ts': '' })
    routes.set('/app.bundle', { body: 'never fetched' })
    routes.set('/app.map', { body: mapJson(['src/a.ts']) })

    await expect(sourceMapFiles(`${origin}/app.bundle`, root)).resolves.toEqual(
      ['src/a.ts'],
    )
    expect(requests).toEqual(['/app.map'])
  })

  test('a script URL with an unmappable suffix has no map', async () => {
    const root = project({ 'src/a.ts': '', 'static/app.css': '' })
    routes.set('/static/app.css', { body: 'a{}' })
    await expect(
      sourceMapFiles(`${origin}/static/app.css`, root),
    ).resolves.toEqual(['static/app.css'])
  })

  test('includes the script path and the mapped sources, sorted and unique', async () => {
    const root = project({
      'public/x.js': '',
      'src/a.ts': '',
      'src/z.ts': '',
    })
    routes.set('/public/x.js', {
      body: `x();\n${DIRECTIVE}${dataMap({
        mappings: '',
        names: [],
        sourceRoot: 'src/',
        sources: ['z.ts', '/a.ts', 'missing.ts'],
        version: 3,
      })}`,
    })
    await expect(
      sourceMapFiles(`${origin}/public/x.js`, root),
    ).resolves.toEqual(['public/x.js', 'src/a.ts', 'src/z.ts'])
  })

  test('indexed maps contribute the sources of every section', async () => {
    const root = project({ 'src/a.ts': '', 'src/b.ts': '' })
    routes.set('/x.js', {
      body: `x();\n${DIRECTIVE}${dataMap({
        sections: [
          {
            map: JSON.parse(mapJson(['src/a.ts'])),
            offset: { column: 0, line: 0 },
          },
          {
            map: JSON.parse(mapJson(['src/b.ts'])),
            offset: { column: 0, line: 1 },
          },
        ],
        version: 3,
      })}`,
    })
    await expect(sourceMapFiles(`${origin}/x.js`, root)).resolves.toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
  })

  test('failed, oversized and invalid maps degrade without throwing', async () => {
    const root = project({ 'public/x.js': '' })
    routes.set('/public/x.js', {
      body: `x();\n${DIRECTIVE}x.map`,
    })
    await expect(
      sourceMapFiles(`${origin}/public/x.js`, root),
    ).resolves.toEqual(['public/x.js'])

    routes.set('/public/x.map', {
      body: '{}',
      headers: { 'content-length': String(40 * 1024 * 1024) },
    })
    clearSourceMapCaches()
    await expect(
      sourceMapFiles(`${origin}/public/x.js`, root),
    ).resolves.toEqual(['public/x.js'])

    routes.set('/public/x.map', { body: 'not json' })
    clearSourceMapCaches()
    await expect(
      sourceMapFiles(`${origin}/public/x.js`, root),
    ).resolves.toEqual(['public/x.js'])

    await expect(
      sourceMapFiles('http://127.0.0.1:9/never.js', root),
    ).resolves.toEqual([])
  })

  test('memoizes per root and script', async () => {
    const root = project({ 'src/a.ts': '' })
    routes.set('/a.js', { body: `a();\n${DIRECTIVE}a.map` })
    routes.set('/a.map', { body: mapJson(['src/a.ts']) })
    await sourceMapFiles(`${origin}/a.js`, root)
    const first = requests.length
    await sourceMapFiles(`${origin}/a.js`, root)
    expect(requests).toHaveLength(first)
  })

  test('the memos stay bounded across many distinct scripts', async () => {
    const root = project({ 'src/a.ts': '' })
    let next = 0
    const operation = async () => {
      next += 1
      const path = `/s${next}.js`
      routes.set(path, {
        body: `s();\n${DIRECTIVE}${dataMap({ mappings: '', names: [], sources: ['src/a.ts'], version: 3 })}`,
      })
      await sourceMapFiles(`${origin}${path}`, root)
    }
    for (let index = 0; index < SOURCE_MAP_CACHE_LIMIT * 3; index += 1) {
      await operation()
    }
    expect(sourceMapCacheSize()).toBeLessThanOrEqual(SOURCE_MAP_CACHE_LIMIT * 2)
    routes.clear()
    await assertNoLeak(operation, { bytesPerOperation: 2048, iterations: 150 })
    expect(sourceMapCacheSize()).toBeLessThanOrEqual(SOURCE_MAP_CACHE_LIMIT * 2)
  })
})

describe('source names', () => {
  test('accepts file, webpack and vite names and drops queries and hashes', async () => {
    const root = project({ 'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '' })
    await expect(
      attribute(root, `file://${join(root, 'src/a.ts')}`),
    ).resolves.toEqual(['src/a.ts'])
    await expect(
      attribute(root, 'webpack://app/./src/b.ts?abc#frag'),
    ).resolves.toEqual(['src/b.ts'])
    await expect(attribute(root, 'webpack:///src/b.ts?abc')).resolves.toEqual([
      'src/b.ts',
    ])
    await expect(attribute(root, 'vite:///src/c.ts#x')).resolves.toEqual([
      'src/c.ts',
    ])
    await expect(
      attribute(root, `/@fs${join(root, 'src/a.ts')}`),
    ).resolves.toEqual(['src/a.ts'])
  })

  test('rejects other schemes, missing files and anything outside the root', async () => {
    const root = project({ 'src/a.ts': '' })
    await expect(attribute(root, 'https://cdn.test/src/a.ts')).resolves.toEqual(
      [],
    )
    await expect(attribute(root, 'src/missing.ts')).resolves.toEqual([])
    await expect(attribute(root, '../outside.ts')).resolves.toEqual([])
    await expect(attribute(root, `file://${root}`)).resolves.toEqual([])
  })

  test('tries the root, then the map directory, for a relative name', async () => {
    const root = project({ 'maps/local.ts': '', 'src/a.ts': '' })
    await expect(
      attribute(root, 'local.ts', 'http://fixture.test/maps/x.js'),
    ).resolves.toEqual(['maps/local.ts'])
    await expect(
      attribute(root, 'src/a.ts', 'http://fixture.test/maps/x.js'),
    ).resolves.toEqual(['src/a.ts'])
  })

  test('never attributes a file under node_modules', async () => {
    const root = project({
      'node_modules/dep/index.js': '',
      'packages/app/node_modules/dep/index.js': '',
      'src/a.ts': '',
    })
    await expect(attribute(root, 'node_modules/dep/index.js')).resolves.toEqual(
      [],
    )
    await expect(
      attribute(root, 'webpack:///./packages/app/node_modules/dep/index.js'),
    ).resolves.toEqual([])
    await expect(attribute(root, 'src/a.ts')).resolves.toEqual(['src/a.ts'])
  })
})
