import type { Instrumenter } from 'istanbul-lib-instrument'

import type { TiaRuntimeGraphPartition } from '../../core/runtime.ts'
import { CoverageTemplates } from '../../engine/coverage/templates.ts'
import type { TiaCoverageRuntime } from '../../engine/coverage/types.ts'
import type { BegunRun } from '../../engine/lifecycle.ts'
import type { VerificationTarget } from '../../engine/verification-snapshot.ts'
import { coverageRuntime, type NormalizedOptions } from './options.ts'

/** Which files the plugin instruments, built from the run's options. */
export interface InstrumentationMatchers {
  readonly exclude: (path: string) => boolean
  readonly include: (path: string) => boolean
}

/**
 * Everything one Vitest instance shares between the plugin hooks and the
 * reporter. The plugin gives each instance its own, so instances in one
 * process never share a plan, a template table or a reporter's evidence.
 */
export interface TiaRuntime {
  active: boolean
  /**
   * Files inside this directory may be recorded even when they sit outside
   * `root`. It is the git repository top when `root` is inside one, and
   * `root` otherwise. Change detection uses the same top.
   */
  boundary: string
  coverage: TiaCoverageRuntime
  coverageTemplates: CoverageTemplates
  instrumenter: Instrumenter | null
  /** Built when the first file is transformed, after the run is planned. */
  matchers: InstrumentationMatchers | null
  options: NormalizedOptions
  partition: TiaRuntimeGraphPartition | null
  root: string
  /** The planned run, once the plugin has planned it. */
  run: BegunRun | null
  structuralFiles: string[]
  /** Read when the run starts, so a misconfiguration fails before any test. */
  verification: VerificationTarget | undefined
}

export function initialRuntime(
  options: NormalizedOptions,
  root: string,
): TiaRuntime {
  return {
    active: false,
    boundary: root,
    coverage: coverageRuntime(root, false, null),
    coverageTemplates: new CoverageTemplates(),
    instrumenter: null,
    matchers: null,
    options,
    partition: null,
    root,
    run: null,
    structuralFiles: [],
    verification: undefined,
  }
}
