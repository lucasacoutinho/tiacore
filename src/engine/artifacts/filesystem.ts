import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { resolve } from 'node:path'

import type {
  TiaArtifactCandidate,
  TiaArtifactProvider,
  TiaFilesystemArtifactOptions,
} from './types.js'

const DEFAULT_PATHS = ['.tia-artifacts']
const MAX_GRAPH_BYTES = 20 * 1024 * 1024
const MAX_FILES = 1_000

function graphFiles(path: string, files: string[]): void {
  if (files.length >= MAX_FILES) {
    return
  }

  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) {
    return
  }
  if (stat.isFile()) {
    if (path.endsWith('graph.json') && stat.size <= MAX_GRAPH_BYTES) {
      files.push(path)
    }
    return
  }
  if (!stat.isDirectory()) {
    return
  }

  for (const entry of readdirSync(path).sort()) {
    graphFiles(resolve(path, entry), files)
    if (files.length >= MAX_FILES) {
      return
    }
  }
}

export function createFilesystemArtifactProvider(
  options: TiaFilesystemArtifactOptions = {},
): TiaArtifactProvider {
  return {
    name: 'filesystem artifacts',
    async load(context) {
      const root = context.root ?? process.cwd()
      const files: string[] = []
      for (const path of options.paths ?? DEFAULT_PATHS) {
        graphFiles(resolve(root, path), files)
      }

      return files.flatMap((path): TiaArtifactCandidate[] => {
        try {
          const graph = JSON.parse(readFileSync(path, 'utf8')) as {
            partition?: { group?: unknown }
          }
          const group =
            typeof graph.partition?.group === 'string'
              ? graph.partition.group
              : options.group
          return [{
            graph,
            ...(group === undefined ? {} : { group }),
            id: path,
          }]
        } catch {
          return []
        }
      })
    },
  }
}
