import { databaseEdges } from './database.ts'
import { subprocessEdges } from './subprocess.ts'
import { viewEdges } from './views.ts'
import type { TiaFrameworkEdgeAdapter, TiaFrameworkOptions } from './types.ts'

export function frameworkAdapters(
  options: TiaFrameworkOptions | undefined,
): TiaFrameworkEdgeAdapter[] {
  if (options === undefined) {
    return []
  }

  const adapters: TiaFrameworkEdgeAdapter[] = []
  if (options.views) {
    adapters.push(viewEdges(options.views))
  }
  if (options.database) {
    adapters.push(databaseEdges(options.database))
  }
  if (options.subprocess) {
    adapters.push(subprocessEdges(options.subprocess))
  }
  if (options.adapters !== undefined) {
    adapters.push(
      ...(Array.isArray(options.adapters)
        ? options.adapters
        : [options.adapters]),
    )
  }
  return adapters
}

export function frameworkFingerprint(
  adapters: TiaFrameworkEdgeAdapter[],
): string {
  return JSON.stringify(
    adapters.map((adapter) => ({
      fingerprint: adapter.fingerprint ?? '',
      name: adapter.name,
    })),
  )
}
