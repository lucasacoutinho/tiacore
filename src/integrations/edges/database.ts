import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { matchingFiles } from './files.js'
import type {
  TiaDatabaseEdgeOptions,
  TiaFrameworkEdgeAdapter,
} from './types.js'

const DEFAULT_MIGRATIONS = [
  'migrations/**/*.{sql,js,cjs,mjs,ts,cts,mts}',
  'prisma/migrations/**/*.{sql,js,cjs,mjs,ts,cts,mts}',
  'drizzle/**/*.{sql,js,cjs,mjs,ts,cts,mts}',
]
const DEFAULT_SCHEMAS = [
  'prisma/schema.prisma',
  'src/db/schema.{js,jsx,ts,tsx}',
  'src/database/schema.{js,jsx,ts,tsx}',
]
const META_TABLES = new Set([
  'information_schema',
  'migrations',
  'sqlite_master',
  'sqlite_sequence',
])

export function tablesFromSql(source: string): string[] {
  const tables = new Set<string>()
  const patterns = [
    /\b(?:from|into|join|update|table)\s+(?:if\s+(?:not\s+)?exists\s+)?["'`[]?([a-z_][\w$.-]*)/gi,
    /\b(?:sqliteTable|pgTable|mysqlTable|table)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:from|table)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:prisma|tx)\.([a-z_]\w*)\.(?:find|create|update|upsert|delete|count|aggregate|groupBy)/gi,
  ]

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1]?.toLowerCase()
      if (raw === undefined || META_TABLES.has(raw) || raw.startsWith('pg_')) {
        continue
      }
      tables.add(raw)
      if (!raw.endsWith('s')) {
        tables.add(`${raw}s`)
      }
    }
  }

  return [...tables].sort()
}

export function databaseEdges(
  configured: true | TiaDatabaseEdgeOptions,
): TiaFrameworkEdgeAdapter {
  const options = configured === true ? {} : configured
  const migrationPatterns = options.migrations ?? DEFAULT_MIGRATIONS
  const schemaPatterns = options.schemas ?? DEFAULT_SCHEMAS
  const cache = new Map<
    string,
    {
      migrations: Array<{ file: string; tables: Set<string> }>
      schemas: string[]
    }
  >()

  return {
    fingerprint: JSON.stringify({
      migrations: migrationPatterns,
      schemas: schemaPatterns,
      version: 1,
    }),
    name: 'database',
    resolve(context) {
      let project = cache.get(context.root)
      if (project === undefined) {
        project = {
          migrations: matchingFiles(context.root, migrationPatterns).map(
            (file) => ({
              file,
              tables: new Set(
                tablesFromSql(
                  readFileSync(resolve(context.root, file), 'utf8'),
                ),
              ),
            }),
          ),
          schemas: matchingFiles(context.root, schemaPatterns),
        }
        cache.set(context.root, project)
      }

      const usedTables = new Set<string>()
      for (const file of context.files) {
        try {
          for (const table of tablesFromSql(
            readFileSync(resolve(context.root, file), 'utf8'),
          )) {
            usedTables.add(table)
          }
        } catch {
          // Deleted and virtual runtime dependencies are handled by the
          // planner's normal conservative fallback.
        }
      }

      if (usedTables.size === 0) {
        return []
      }

      return [
        ...project.schemas,
        ...project.migrations
          .filter((migration) =>
            [...migration.tables].some((table) => usedTables.has(table)),
          )
          .map((migration) => migration.file),
      ]
    },
  }
}
