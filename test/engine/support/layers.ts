import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'

import { BaselinesLive } from '../../../src/engine/baseline/live.ts'
import { GraphStoreLive } from '../../../src/engine/state/graph-store.ts'

/** The live engine services over the Node platform. */
export const EngineLive = Layer.mergeAll(GraphStoreLive, BaselinesLive).pipe(
  Layer.provideMerge(NodeServices.layer),
)

/** A fresh temporary directory removed when the test scope closes. */
export const tempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.makeTempDirectoryScoped({ prefix })
  })
