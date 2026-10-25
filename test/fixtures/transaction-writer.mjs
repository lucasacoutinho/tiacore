// Commits one proposed graph to a shared cache directory from its own process.
// Arguments: cacheDir expectedPath proposedPath. Exit 0 on committed or merged,
// 2 on conflict, 64 on usage errors.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'

const source = (path) =>
  import(fileURLToPath(new URL(`../../src/${path}`, import.meta.url)))

const [cacheDir, expectedPath, proposedPath] = process.argv.slice(2)
if (
  cacheDir === undefined ||
  expectedPath === undefined ||
  proposedPath === undefined
) {
  process.exitCode = 64
} else {
  const { GraphStore } = await source('engine/ports.ts')
  const { GraphStoreLive } = await source('engine/state/graph-store.ts')
  const { graphDigest } = await source('engine/state/segments.ts')
  const { Layer } = await import('effect')
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
  const graph = JSON.parse(readFileSync(proposedPath, 'utf8'))
  const result = await Effect.runPromise(
    Effect.flatMap(GraphStore, (store) =>
      store.commit(cacheDir, {
        expected,
        expectedDigest: graphDigest(expected),
        graph,
      }),
    ).pipe(
      Effect.provide(GraphStoreLive.pipe(Layer.provide(NodeServices.layer))),
    ),
  )
  process.stdout.write(`${result.status}\n`)
  if (result.status === 'conflict') process.exitCode = 2
}
