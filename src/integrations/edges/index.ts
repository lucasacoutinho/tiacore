import { databaseEdges } from './database.js'
import { subprocessEdges } from './subprocess.js'
import { viewEdges } from './views.js'
import type {
  TiaFrameworkEdgeAdapter,
  TiaFrameworkOptions,
} from './types.js'

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
