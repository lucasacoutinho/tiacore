import * as Layer from 'effect/Layer'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as Otlp from 'effect/observability/Otlp'
import * as OtlpSerialization from 'effect/observability/OtlpSerialization'

import { VERSION } from '../core/version.ts'

/** OTLP/HTTP JSON export of traces, metrics and logs to `baseUrl`. */
export function otlpLayer(baseUrl: string): Layer.Layer<never> {
  return Otlp.layer({
    baseUrl,
    resource: { serviceName: 'tiacore', serviceVersion: VERSION },
  }).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  )
}
