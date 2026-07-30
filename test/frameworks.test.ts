import { describe, expect, test } from 'vitest'

import { tablesFromSql } from '../src/frameworks/database.js'
import { resolveFrameworkEdges } from '../src/frameworks/resolve.js'

describe('framework edge adapters', () => {
  test('extracts SQL, query-builder, and Prisma table references', () => {
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

  test('contains custom adapter paths and marks failures incomplete', () => {
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
