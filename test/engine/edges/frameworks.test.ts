import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from '@effect/vitest'
import * as Arbitrary from 'effect/Arbitrary'
import * as Schema from 'effect/Schema'

import {
  databaseEdges,
  tablesFromSql,
} from '../../../src/engine/edges/database.ts'
import { matchingFiles } from '../../../src/engine/edges/files.ts'
import {
  frameworkAdapters,
  frameworkFingerprint,
} from '../../../src/engine/edges/index.ts'
import { resolveFrameworkEdges } from '../../../src/engine/edges/resolve.ts'
import { subprocessEdges } from '../../../src/engine/edges/subprocess.ts'
import type {
  TiaFrameworkEdgeAdapter,
  TiaFrameworkEdgeContext,
  TiaFrameworkOptions,
} from '../../../src/engine/edges/types.ts'
import { viewEdges } from '../../../src/engine/edges/views.ts'
import { assertNoLeak } from '../../support/leak.ts'
import { legacy } from '../../support/legacy.ts'

interface Legacy {
  databaseEdges: typeof databaseEdges
  frameworkAdapters: typeof frameworkAdapters
  frameworkFingerprint: typeof frameworkFingerprint
  matchingFiles: typeof matchingFiles
  resolveFrameworkEdges: typeof resolveFrameworkEdges
  subprocessEdges: typeof subprocessEdges
  tablesFromSql: typeof tablesFromSql
  viewEdges: typeof viewEdges
}

const old = {
  ...(await legacy<Legacy>('integrations/edges/database.js')),
  ...(await legacy<Legacy>('integrations/edges/files.js')),
  ...(await legacy<Legacy>('integrations/edges/index.js')),
  ...(await legacy<Legacy>('integrations/edges/resolve.js')),
  ...(await legacy<Legacy>('integrations/edges/subprocess.js')),
  ...(await legacy<Legacy>('integrations/edges/views.js')),
}

const roots: string[] = []

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-edges-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

const context = (
  root: string,
  files: string[],
  testFile = 'test/a.test.ts',
): TiaFrameworkEdgeContext => ({ files, root, testFile })

describe('framework edge adapters', () => {
  it('extracts SQL, query-builder, and Prisma table references', () => {
    expect(
      tablesFromSql(`
        SELECT users.id FROM "users"
        JOIN orders ON orders.user_id = users.id;
        db.select().from('audit_log');
        prisma.account.findMany();
        sqliteTable('sessions', {});
        SELECT * FROM sqlite_master;
      `),
    ).toEqual([
      'account',
      'accounts',
      'audit_log',
      'audit_logs',
      'orders',
      'sessions',
      'users',
    ])
  })

  it('contains custom adapter paths and marks failures incomplete', () => {
    const root = process.cwd()
    const resolved = resolveFrameworkEdges(
      [
        {
          name: 'custom',
          resolve: () => ['README.md', '../outside.txt'],
        },
      ],
      { files: [], root, testFile: 'test/example.test.ts' },
    )
    expect(resolved).toEqual({
      complete: true,
      files: ['README.md'],
    })

    expect(
      resolveFrameworkEdges(
        [
          {
            name: 'broken',
            resolve() {
              throw new Error('unavailable framework')
            },
          },
        ],
        { files: [], root, testFile: 'test/example.test.ts' },
      ),
    ).toEqual({ complete: false, files: [] })
  })
})

/** An adapter whose output breaks the declared contract. */
const broken = (resolve: () => unknown): TiaFrameworkEdgeAdapter => ({
  name: 'broken',
  resolve: resolve as () => string[],
})

describe('resolveFrameworkEdges', () => {
  const root = '/project'
  const at = { files: [], root, testFile: 'test/a.test.ts' }

  it('normalizes, de-duplicates and sorts across adapters (EDGE-RES-01)', () => {
    expect(
      resolveFrameworkEdges(
        [
          { name: 'one', resolve: () => ['b.ts', '/project/a.ts', './b.ts'] },
          {
            name: 'two',
            resolve: () => ['a.ts', '/project', '/elsewhere/x.ts'],
          },
        ],
        at,
      ),
    ).toEqual({ complete: true, files: ['a.ts', 'b.ts'] })
  })

  it('discards earlier results and stops at the first failing adapter (EDGE-RES-02)', () => {
    let later = 0
    const after: TiaFrameworkEdgeAdapter = {
      name: 'after',
      resolve: () => {
        later += 1
        return []
      },
    }
    const first: TiaFrameworkEdgeAdapter = {
      name: 'first',
      resolve: () => ['a.ts'],
    }
    for (const failure of [
      broken(() => undefined),
      broken(() => Promise.resolve(['a.ts'])),
      broken(() => {
        throw new Error('unavailable')
      }),
      broken(() => 42),
    ]) {
      expect(resolveFrameworkEdges([first, failure, after], at)).toEqual({
        complete: false,
        files: [],
      })
    }
    expect(later).toBe(0)
  })

  it('agrees with 1.x on arbitrary adapter output', () => {
    const outcomes = [
      ['a.ts'],
      ['../up.ts', 'a/../b.ts'],
      [],
      ['/project/c.ts', '/project/'],
    ]
    for (const first of outcomes) {
      for (const second of outcomes) {
        const adapters: TiaFrameworkEdgeAdapter[] = [
          { name: 'one', resolve: () => first },
          { name: 'two', resolve: () => second },
        ]
        expect(resolveFrameworkEdges(adapters, at)).toEqual(
          old.resolveFrameworkEdges(adapters, at),
        )
      }
    }
  })
})

const adapterNames = (options: TiaFrameworkOptions | undefined) =>
  frameworkAdapters(options).map((adapter) => adapter.name)

describe('frameworkAdapters', () => {
  it('orders views, database, subprocess, then custom adapters (EDGE-IDX-01)', () => {
    const custom: TiaFrameworkEdgeAdapter = { name: 'mine', resolve: () => [] }
    const other: TiaFrameworkEdgeAdapter = { name: 'other', resolve: () => [] }

    expect(adapterNames(undefined)).toEqual([])
    expect(adapterNames({})).toEqual([])
    expect(adapterNames({ database: false, views: false })).toEqual([])
    expect(
      adapterNames({
        adapters: [custom, other],
        database: true,
        subprocess: { mappings: [] },
        views: true,
      }),
    ).toEqual(['views', 'database', 'subprocess', 'mine', 'other'])
    expect(adapterNames({ adapters: custom })).toEqual(['mine'])
    expect(frameworkAdapters({ adapters: custom })[0]).toBe(custom)
  })

  it('fingerprints names and fingerprints in adapter order (EDGE-IDX-02)', () => {
    const adapters = frameworkAdapters({
      adapters: [{ name: 'mine', resolve: () => [] }],
      database: true,
      views: { extensions: ['md'], roots: ['docs'] },
    })
    const fingerprint = frameworkFingerprint(adapters)
    expect(fingerprint).toBe(frameworkFingerprint(adapters))
    expect(JSON.parse(fingerprint)).toEqual([
      {
        fingerprint: JSON.stringify({
          extensions: ['.md'],
          roots: ['docs'],
          version: 1,
        }),
        name: 'views',
      },
      {
        fingerprint: JSON.stringify({
          migrations: [
            'migrations/**/*.{sql,js,cjs,mjs,ts,cts,mts}',
            'prisma/migrations/**/*.{sql,js,cjs,mjs,ts,cts,mts}',
            'drizzle/**/*.{sql,js,cjs,mjs,ts,cts,mts}',
          ],
          schemas: [
            'prisma/schema.prisma',
            'src/db/schema.{js,jsx,ts,tsx}',
            'src/database/schema.{js,jsx,ts,tsx}',
          ],
          version: 1,
        }),
        name: 'database',
      },
      { fingerprint: '', name: 'mine' },
    ])
    expect(frameworkFingerprint(adapters.toReversed()) === fingerprint).toBe(
      false,
    )
  })
})

describe('matchingFiles', () => {
  it('skips build output, git and symlinks, and returns sorted paths (EDGE-FILE-01)', () => {
    const root = project({
      '.hidden/x.sql': '',
      'a/b/c.sql': '',
      'b.sql': '',
      'build/m.sql': '',
      'deep/node_modules/m.sql': '',
      'dist/m.sql': '',
      'node_modules/m.sql': '',
      'z/coverage/m.sql': '',
    })
    symlinkSync(join(root, 'b.sql'), join(root, 'link.sql'))
    symlinkSync(join(root, 'a'), join(root, 'linked-dir'))
    expect(matchingFiles(root, ['**/*.sql'])).toEqual([
      '.hidden/x.sql',
      'a/b/c.sql',
      'b.sql',
    ])
    expect(matchingFiles(root, [])).toEqual([])
    expect(matchingFiles(root, ['**/*.sql'])).toEqual(
      old.matchingFiles(root, ['**/*.sql']),
    )
  })
})

describe('database edges', () => {
  const files = {
    'migrations/001_users.sql': 'CREATE TABLE users (id int);',
    'migrations/002_orders.sql': 'CREATE TABLE orders (id int);',
    'prisma/schema.prisma': 'model User {}',
    'src/db/schema.ts': 'export const t = 1',
    'src/user.ts': 'db.select().from("users")',
    'src/util.ts': 'export const noop = 1',
  }

  it('depends on schemas and the migrations of the tables in use (EDGE-DB-04/05)', () => {
    const root = project(files)
    const adapter = databaseEdges(true)
    expect(adapter.name).toBe('database')
    expect(adapter.resolve(context(root, ['src/user.ts']))).toEqual([
      'prisma/schema.prisma',
      'src/db/schema.ts',
      'migrations/001_users.sql',
    ])
    expect(
      adapter.resolve(context(root, ['src/util.ts', 'src/gone.ts'])),
    ).toEqual([])
  })

  it('matches 1.x for every combination of used files (differential)', () => {
    const root = project(files)
    const names = Object.keys(files)
    for (let mask = 0; mask < 2 ** names.length; mask += 1) {
      const used = names.filter((_, index) => (mask & (1 << index)) !== 0)
      expect(databaseEdges(true).resolve(context(root, used))).toEqual(
        old.databaseEdges(true).resolve(context(root, used)),
      )
    }
  })

  it('scans migrations once per root for the life of the adapter (EDGE-DB-06)', () => {
    const root = project(files)
    const adapter = databaseEdges(true)
    const used = context(root, ['src/user.ts'])
    const before = adapter.resolve(used)
    writeFileSync(
      join(root, 'migrations/003_more_users.sql'),
      'ALTER TABLE users',
    )
    expect(adapter.resolve(used)).toEqual(before)
    expect(databaseEdges(true).resolve(used)).toContain(
      'migrations/003_more_users.sql',
    )
  })

  it('honors configured globs and keeps the fingerprint shape', () => {
    const root = project({
      'db/m1.sql': 'create table users',
      'db/schema.sql': '',
      'src/q.ts': 'from users',
    })
    const adapter = databaseEdges({
      migrations: ['db/m*.sql'],
      schemas: ['db/schema.sql'],
    })
    expect(adapter.resolve(context(root, ['src/q.ts']))).toEqual([
      'db/schema.sql',
      'db/m1.sql',
    ])
    expect(JSON.parse(adapter.fingerprint ?? '')).toEqual({
      migrations: ['db/m*.sql'],
      schemas: ['db/schema.sql'],
      version: 1,
    })
  })

  it('ignores meta tables and keeps qualified names verbatim (EDGE-DB-03)', () => {
    expect(
      tablesFromSql(
        'from information_schema from migrations from pg_catalog from sqlite_sequence from public.users from Users',
      ),
    ).toEqual(['public.users', 'users'])
  })

  const sqlish = Arbitrary.array(
    Arbitrary.schema(
      Schema.Literals([
        'from',
        'FROM',
        'into',
        'join',
        'update',
        'table',
        'if not exists',
        'users',
        'Orders',
        'pg_x',
        'sqlite_master',
        '"quoted"',
        "'single'",
        '(',
        ')',
        'prisma.',
        'tx.',
        'account.',
        'findMany()',
        'sqliteTable(',
        'x.y',
        ' ',
        '\n',
      ]),
    ),
    { maxLength: 16 },
  ).pipe(Arbitrary.map((parts) => parts.join(' ')))

  it.prop(
    'extracts exactly the tables 1.x extracts',
    [sqlish],
    ([source]) => {
      expect(tablesFromSql(source)).toEqual(old.tablesFromSql(source))
    },
    { arbitrary: { runs: 1000 } },
  )

  it('keeps one cache entry per root', async () => {
    const root = project(files)
    const adapter = databaseEdges(true)
    const result = await assertNoLeak(
      () => adapter.resolve(context(root, ['src/user.ts'])),
      { bytesPerOperation: 64, iterations: 300 },
    )
    expect(result.bytesPerOperation).toBeLessThan(64)
  })
})

describe('view edges', () => {
  const files = {
    'src/page.ts': `render('home') ; renderFile("./partials/nav.ejs") ; const x = "layouts/main.njk"`,
    'src/partials/nav.ejs': '',
    'src/views/home.pug': '',
    'src/views/layouts/main.njk': '',
    'templates/home.html': '',
    'views/home.ejs': '',
    'views/home.pug': '',
  }

  it('finds literal and call-pattern view names from dependency files (EDGE-VIEW-02/03)', () => {
    const root = project(files)
    const adapter = viewEdges(true)
    expect(adapter.name).toBe('views')
    expect(
      adapter.resolve(context(root, ['src/page.ts', 'src/missing.ts'])),
    ).toEqual([
      'src/partials/nav.ejs',
      'src/views/home.pug',
      'src/views/layouts/main.njk',
      'templates/home.html',
      'views/home.ejs',
      'views/home.pug',
    ])
  })

  it('normalizes configured extensions into the fingerprint (EDGE-VIEW-01/04)', () => {
    const adapter = viewEdges({ extensions: ['md', '.mdx'], roots: ['docs'] })
    expect(JSON.parse(adapter.fingerprint ?? '')).toEqual({
      extensions: ['.md', '.mdx'],
      roots: ['docs'],
      version: 1,
    })
    expect(
      JSON.parse(viewEdges(true).fingerprint ?? '').extensions,
    ).toHaveLength(9)
  })

  it('matches 1.x for every combination of dependency files (differential)', () => {
    const root = project(files)
    const names = Object.keys(files)
    for (let mask = 0; mask < 2 ** names.length; mask += 1) {
      const used = names.filter((_, index) => (mask & (1 << index)) !== 0)
      expect(viewEdges(true).resolve(context(root, used))).toEqual(
        old.viewEdges(true).resolve(context(root, used)),
      )
    }
  })
})

describe('subprocess edges', () => {
  const files = {
    '.hidden/c.mjs': '',
    'src/child.mjs': '',
    'src/other.mjs': '',
    'test/.hidden.test.ts': '',
    'test/child.test.ts': '',
  }
  const options = {
    mappings: [
      { files: ['src/child.mjs'], tests: ['test/child.test.ts'] },
      { files: ['.hidden/*.mjs'], tests: ['test/*.test.ts'] },
    ],
  }

  it('maps matching tests to files and nothing else (EDGE-SUB-01/04)', () => {
    const root = project(files)
    const adapter = subprocessEdges(options)
    expect(adapter.name).toBe('subprocess')
    expect(adapter.resolve(context(root, [], 'test/child.test.ts'))).toEqual([
      'src/child.mjs',
      '.hidden/c.mjs',
    ])
    expect(adapter.resolve(context(root, [], 'test/other.test.ts'))).toEqual([
      '.hidden/c.mjs',
    ])
    expect(adapter.resolve(context(root, [], 'lib/x.ts'))).toEqual([])
  })

  it('does not match dotfile tests with a star pattern (1.x quirk, EDGE-SUB-01)', () => {
    const root = project(files)
    expect(
      subprocessEdges(options).resolve(
        context(root, [], 'test/.hidden.test.ts'),
      ),
    ).toEqual([])
  })

  it('fingerprints sorted mappings without a version (EDGE-SUB-02)', () => {
    const left = subprocessEdges({
      mappings: [{ files: ['b', 'a'], tests: ['y', 'x'] }],
    })
    const right = subprocessEdges({
      mappings: [{ files: ['a', 'b'], tests: ['x', 'y'] }],
    })
    expect(left.fingerprint).toBe(right.fingerprint)
    expect(JSON.parse(left.fingerprint ?? '')).toEqual([
      { files: ['a', 'b'], tests: ['x', 'y'] },
    ])
    expect(left.fingerprint).toBe(
      old.subprocessEdges({
        mappings: [{ files: ['b', 'a'], tests: ['y', 'x'] }],
      }).fingerprint,
    )
  })
})
