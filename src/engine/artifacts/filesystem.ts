import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { MAX_ARTIFACT_ARCHIVE_BYTES, readArtifactArchive } from './archive.js'
import { readGraph } from '../state/store.js'

import type {
  TiaArtifactCandidate,
  TiaArtifactProvider,
  TiaFilesystemArtifactOptions,
} from './types.js'

const DEFAULT_PATHS = ['.tia-artifacts']
const MAX_FILES = 1_000

function artifactFiles(path: string, files: string[]): void {
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
    if (
      (path.endsWith('state.json') || path.endsWith('.zip')) &&
      stat.size <= MAX_ARTIFACT_ARCHIVE_BYTES
    ) {
      files.push(path)
    }
    return
  }
  if (!stat.isDirectory()) {
    return
  }

  for (const entry of readdirSync(path).sort()) {
    artifactFiles(resolve(path, entry), files)
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
        artifactFiles(resolve(root, path), files)
      }

      return files.flatMap((path): TiaArtifactCandidate[] => {
        try {
          const isArchive = path.endsWith('.zip')
          const archived = isArchive
            ? readArtifactArchive(
                new Uint8Array(readFileSync(path)),
                context.runner,
              )
            : null
          if (isArchive && archived === null) return []
          const graph = archived?.graph ?? readGraph(resolve(path, '..'))
          if (graph === null) return []
          const group =
            typeof graph.partition?.group === 'string'
              ? graph.partition.group
              : options.group
          return [
            {
              ...(archived?.attestation === undefined
                ? {}
                : { attestation: archived.attestation }),
              graph,
              ...(archived === null
                ? {}
                : { graphSha256: archived.graphSha256 }),
              ...(group === undefined ? {} : { group }),
              id: path,
            },
          ]
        } catch {
          return []
        }
      })
    },
  }
}
