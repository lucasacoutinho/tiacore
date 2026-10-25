import * as Layer from 'effect/Layer'

import { BaselinesLive } from './baseline/live.ts'
import { GraphStoreLive } from './state/graph-store.ts'

/** The live engine seams: the file-system graph store and git or file-snapshot baselines. */
export const EngineLive = Layer.mergeAll(GraphStoreLive, BaselinesLive)
