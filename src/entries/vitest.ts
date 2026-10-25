export {
  tia,
  tia as default,
  type TiaPlugin,
} from '../runners/vitest/plugin.ts'
export type { TiaOptions } from '../runners/vitest/options.ts'
export type {
  TiaCoverageOptions,
  TiaCoverageReporter,
  TiaCoverageReporterConfig,
  TiaCoverageThresholds,
  TiaCoverageThresholdValues,
  TiaCoverageWatermarks,
} from '../engine/coverage/types.ts'
export type {
  TiaDatabaseEdgeOptions,
  TiaFrameworkEdgeAdapter,
  TiaFrameworkEdgeContext,
  TiaFrameworkOptions,
  TiaSubprocessEdgeMapping,
  TiaSubprocessEdgeOptions,
  TiaViewEdgeOptions,
} from '../engine/edges/types.ts'
export type {
  TiaReplayAdapter,
  TiaReplayCompleteEvent,
  TiaReplayedTestEvent,
  TiaReplayReporter,
  TiaReplayRunEvent,
} from '../core/replay.ts'
export type {
  TiaArtifactCandidate,
  TiaArtifactProvider,
  TiaArtifactProviderContext,
  TiaArtifactSource,
  TiaArtifactTrustPolicy,
  TiaFilesystemArtifactOptions,
  TiaGitHubActionsOptions,
  TiaGitLabCiOptions,
  TiaHttpManifestOptions,
} from '../core/artifacts.ts'
