import { resolve } from 'node:path'

import { projectRelative } from '../../shared/paths.js'

interface ModuleNodeLike {
  file: string | null
  id: string | null
  importedModules: Set<ModuleNodeLike>
}

export interface ModuleGraphLike {
  getModuleById(id: string): ModuleNodeLike | undefined
  getModulesByFile(file: string): Set<ModuleNodeLike> | undefined
}

const EXECUTABLE_SOURCE_PATTERN = /\.[cm]?[jt]sx?$/i

function cleanId(id: string): string {
  return id.split('?', 1)[0] ?? id
}

function moduleFile(node: ModuleNodeLike): string | null {
  const value = node.file ?? node.id
  return value === null ? null : cleanId(value)
}

function entryModules(
  graph: ModuleGraphLike,
  moduleId: string,
): ModuleNodeLike[] {
  const cleanModuleId = cleanId(moduleId)
  const direct =
    graph.getModuleById(moduleId) ?? graph.getModuleById(cleanModuleId)
  const byFile = graph.getModulesByFile(resolve(cleanModuleId))

  return [
    ...new Set([
      ...(direct === undefined ? [] : [direct]),
      ...(byFile ?? []),
    ]),
  ]
}

export function importedAssetFiles(
  graph: ModuleGraphLike,
  moduleId: string,
  root: string,
): string[] {
  const queue = entryModules(graph, moduleId)
  const visited = new Set<ModuleNodeLike>()
  const assets = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || visited.has(current)) {
      continue
    }
    visited.add(current)

    for (const imported of current.importedModules) {
      queue.push(imported)

      const file = moduleFile(imported)
      if (file === null || EXECUTABLE_SOURCE_PATTERN.test(file)) {
        continue
      }

      const relative = projectRelative(root, file)
      if (relative !== null && relative !== '') {
        assets.add(relative)
      }
    }
  }

  return [...assets].sort()
}

export function directlyImportedAssetFiles(
  graph: ModuleGraphLike,
  moduleId: string,
  root: string,
): string[] {
  const assets = new Set<string>()

  for (const entry of entryModules(graph, moduleId)) {
    for (const imported of entry.importedModules) {
      const file = moduleFile(imported)
      if (file === null || EXECUTABLE_SOURCE_PATTERN.test(file)) {
        continue
      }

      const relative = projectRelative(root, file)
      if (relative !== null && relative !== '') {
        assets.add(relative)
      }
    }
  }

  return [...assets].sort()
}
