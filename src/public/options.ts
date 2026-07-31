import type { TiaArtifactSource } from '../engine/artifacts/types.js'
import type {
  TiaReplayAdapter,
  TiaReplayReporter,
} from '../engine/replay/types.js'
import type { TiaCoverageOptions } from '../integrations/coverage/types.js'
import type { TiaFrameworkOptions } from '../integrations/edges/types.js'

export interface TiaOptions {
  enabled?: boolean
  cacheDir?: string
  shardGroup?: string
  include?: string[]
  exclude?: string[]
  ignoreChanges?: string[]
  fresh?: boolean
  onUnknownChange?: 'full' | 'ignore'
  log?: boolean
  coverage?: boolean | TiaCoverageOptions
  artifacts?: TiaArtifactSource | TiaArtifactSource[]
  frameworks?: TiaFrameworkOptions
  replayAdapters?: TiaReplayAdapter | TiaReplayAdapter[]
  replayReporters?: TiaReplayReporter | TiaReplayReporter[]
}
