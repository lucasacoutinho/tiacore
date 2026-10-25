import { resolve } from 'node:path'

import type { Instrumenter } from 'istanbul-lib-instrument'

import type {
  Baseline,
  RunPlan,
  TiaRuntimeGraph,
  TiaRuntimeGraphPartition,
} from '../../core/runtime.ts'
import { CoverageTemplates } from '../../engine/coverage/templates.ts'
import type { TiaCoverageRuntime } from '../../engine/coverage/types.ts'
import { coverageRuntime, type NormalizedOptions } from './options.ts'

/** Everything one Vitest run shares between the plugin hooks and the reporter. */
export interface TiaRuntime {
  active: boolean
  baselineAtStart: Baseline | null
  coverage: TiaCoverageRuntime
  coverageTemplates: CoverageTemplates
  fingerprintAtStart: string
  graphAtStart: TiaRuntimeGraph | null
  graphDigestAtStart: string | null
  ignoredPrefixes: string[]
  instrumenter: Instrumenter | null
  options: NormalizedOptions
  partition: TiaRuntimeGraphPartition | null
  plan: RunPlan | null
  root: string
  structuralFiles: string[]
  writeCacheDir: string
}

export function initialRuntime(
  options: NormalizedOptions,
  root: string,
): TiaRuntime {
  return {
    active: false,
    baselineAtStart: null,
    coverage: coverageRuntime(root, false, null),
    coverageTemplates: new CoverageTemplates(),
    fingerprintAtStart: '',
    graphAtStart: null,
    graphDigestAtStart: null,
    ignoredPrefixes: [],
    instrumenter: null,
    options,
    partition: null,
    plan: null,
    root,
    structuralFiles: [],
    writeCacheDir: resolve(root, options.cacheDir),
  }
}
