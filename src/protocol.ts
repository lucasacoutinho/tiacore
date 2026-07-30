export { normalizeProtocolPath, normalizeProtocolPaths } from './protocol/paths.js'
export {
  TIA_PROTOCOL_LIMITS,
  parseArtifactEnvelope,
  parseImpactGraph,
} from './protocol/validate.js'
export {
  TIA_PROTOCOL_VERSION,
  type TiaArtifactEnvelope,
  type TiaChangeSet,
  type TiaDependencyObservation,
  type TiaEdgeConfidence,
  type TiaEdgeKind,
  type TiaExecutionPolicy,
  type TiaImpactGraph,
  type TiaImpactPlan,
  type TiaImpactPlanInput,
  type TiaImpactPlanMode,
  type TiaInvalidator,
  type TiaProtocolVersion,
  type TiaSuiteDescriptor,
} from './protocol/types.js'
