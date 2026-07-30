import { resolve } from 'node:path'

import { projectRelative } from '../shared/paths.js'
import type {
  TiaFrameworkEdgeAdapter,
  TiaFrameworkEdgeContext,
} from '../shared/types.js'

export interface FrameworkEdgeResult {
  complete: boolean
  files: string[]
}

export function resolveFrameworkEdges(
  adapters: TiaFrameworkEdgeAdapter[],
  context: TiaFrameworkEdgeContext,
): FrameworkEdgeResult {
  const files = new Set<string>()

  for (const adapter of adapters) {
    try {
      for (const file of adapter.resolve(context)) {
        const relative = projectRelative(context.root, resolve(context.root, file))
        if (relative !== null && relative !== '') {
          files.add(relative)
        }
      }
    } catch {
      return { complete: false, files: [] }
    }
  }

  return { complete: true, files: [...files].sort() }
}
