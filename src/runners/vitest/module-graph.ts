import { resolve } from 'node:path'

import { trackedFile } from '../../engine/host-path.ts'

interface ModuleNodeLike {
  file: string | null
  id: string | null
  importedModules: Set<ModuleNodeLike>
}

export interface ModuleGraphLike {
  getModuleById(id: string): ModuleNodeLike | undefined
  getModulesByFile(file: string): Set<ModuleNodeLike> | undefined
}

const EXECUTABLE_SOURCE_PATTERN = /\.[cm]?[jt]sx?$/iu
/** Vite queries that import a file as text, a URL or a worker, so it never runs here. */
const ASSET_QUERY_PATTERN =
  /[?&](?:inline|raw|sharedworker|url|worker)(?:[&=]|$)/u

function cleanId(id: string): string {
  return id.split('?', 1)[0] ?? id
}

function moduleFile(node: ModuleNodeLike): string | null {
  const value = node.file ?? node.id
  return value === null ? null : cleanId(value)
}

/**
 * The file a module stands for when it is not instrumented code that runs in
 * the test: a non-script file, or a script imported through an asset query.
 */
function assetFile(node: ModuleNodeLike): string | null {
  const file = moduleFile(node)
  if (file === null || !EXECUTABLE_SOURCE_PATTERN.test(file)) return file
  return node.id !== null && ASSET_QUERY_PATTERN.test(node.id) ? file : null
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
    ...new Set([...(direct === undefined ? [] : [direct]), ...(byFile ?? [])]),
  ]
}

export function importedAssetFiles(
  graph: ModuleGraphLike,
  moduleId: string,
  root: string,
  repositoryRoot = root,
): string[] {
  const modules = new Set(entryModules(graph, moduleId))
  const assets = new Set<string>()

  // Set iteration also visits modules discovered during the walk, once each.
  for (const current of modules) {
    for (const imported of current.importedModules) {
      modules.add(imported)

      const file = assetFile(imported)
      if (file === null) continue

      const relative = trackedFile(root, file, repositoryRoot)
      if (relative !== null) {
        assets.add(relative)
      }
    }
  }

  return [...assets].sort()
}

const MAX_CACHED_PATHS = 1_024
const MAX_CACHED_ASSETS = 50_000

/** Reuse transitive asset walks while merging one completed Vitest run. */
export function assetLookup(root: string, repositoryRoot: string) {
  const byGraph = new Map<ModuleGraphLike, Map<string, string[]>>()
  let cachedPaths = 0
  let cachedAssets = 0
  return (graph: ModuleGraphLike, path: string): string[] => {
    const paths = byGraph.get(graph)
    const cached = paths?.get(path)
    if (cached !== undefined) return cached
    const assets = importedAssetFiles(graph, path, root, repositoryRoot)
    if (
      cachedPaths < MAX_CACHED_PATHS &&
      cachedAssets + assets.length <= MAX_CACHED_ASSETS
    ) {
      if (paths === undefined) byGraph.set(graph, new Map([[path, assets]]))
      else paths.set(path, assets)
      cachedPaths += 1
      cachedAssets += assets.length
    }
    return assets
  }
}

export function directlyImportedAssetFiles(
  graph: ModuleGraphLike,
  moduleId: string,
  root: string,
  repositoryRoot = root,
): string[] {
  const assets = new Set<string>()

  for (const entry of entryModules(graph, moduleId)) {
    for (const imported of entry.importedModules) {
      const file = assetFile(imported)
      if (file === null) continue

      const relative = trackedFile(root, file, repositoryRoot)
      if (relative !== null) {
        assets.add(relative)
      }
    }
  }

  return [...assets].sort()
}
