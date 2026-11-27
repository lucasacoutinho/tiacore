import * as Effect from 'effect/Effect'

import type {
  TiaArtifactSource,
  TiaArtifactTrustPolicy,
} from '../../core/artifacts.ts'
import type { RestoreOutcome, RestoreRequest } from '../lifecycle.ts'

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
  const { artifactProviders, restoreKeeping } = yield* Effect.promise(
    () => import('./restore.ts'),
  )
  const providers = artifactProviders([...sources])
  return (request: RestoreRequest) =>
    restoreKeeping({ ...request, log, providers, trust }).pipe(
      Effect.map(({ kept, result }): RestoreOutcome =>
        kept === null ? result : { ...result, local: kept },
      ),
    )
})
