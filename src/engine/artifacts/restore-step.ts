import * as Effect from 'effect/Effect'

import type {
  TiaArtifactSource,
  TiaArtifactTrustPolicy,
} from '../../core/artifacts.ts'
import type { RestoreRequest } from '../lifecycle.ts'

/**
 * The lifecycle's restore step for `sources`, or undefined when there are
 * none. The artifact code (archives, signatures, HTTP providers) is imported
 * only when a source is configured, so runs without artifacts never load it.
 */
export const artifactRestore = Effect.fnUntraced(function* (
  sources: readonly TiaArtifactSource[],
  log: boolean,
  trust: TiaArtifactTrustPolicy,
) {
  if (sources.length === 0) return undefined
  const { artifactProviders, restoreGraph } = yield* Effect.promise(
    () => import('./restore.ts'),
  )
  const providers = artifactProviders([...sources])
  return (request: RestoreRequest) =>
    restoreGraph({ ...request, log, providers, trust })
})
