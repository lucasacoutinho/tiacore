import type {} from './adapters/vitest/augmentations.js'

export { tia } from './adapters/vitest/plugin.js'
export type { TiaPlugin } from './adapters/vitest/plugin.js'
export type {
  TiaArtifactCandidate,
  TiaArtifactProvider,
  TiaArtifactProviderContext,
  TiaArtifactSource,
  TiaCoverageOptions,
  TiaCoverageReporter,
  TiaCoverageReporterConfig,
  TiaCoverageThresholds,
  TiaCoverageThresholdValues,
  TiaCoverageWatermarks,
  TiaDatabaseEdgeOptions,
  TiaFrameworkEdgeAdapter,
  TiaFrameworkEdgeContext,
  TiaFrameworkOptions,
  TiaFilesystemArtifactOptions,
  TiaGitHubActionsOptions,
  TiaGitLabCiOptions,
  TiaHttpManifestOptions,
  TiaOptions,
  TiaReplayAdapter,
  TiaReplayCompleteEvent,
  TiaReplayedTestEvent,
  TiaReplayReporter,
  TiaReplayRunEvent,
  TiaSubprocessEdgeMapping,
  TiaSubprocessEdgeOptions,
  TiaViewEdgeOptions,
} from './shared/types.js'

export { tia as default } from './adapters/vitest/plugin.js'
