import type { RuntimePlanOptions } from '../../core/runtime.ts'

/** What a project fingerprint covers. Effect-free: the public `TiaCore` options extend it. */
export interface FingerprintOptions extends Pick<
  RuntimePlanOptions,
  'ignoreChanges' | 'onUnknownChange'
> {
  readonly exclude: readonly string[]
  readonly frameworkFingerprint: string
  readonly include: readonly string[]
}
