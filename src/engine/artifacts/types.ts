export interface TiaGitHubActionsOptions {
  apiUrl?: string
  artifactName?: string
  branch?: string
  maxArtifacts?: number
  repository?: string
  runId?: number | string
  tokenEnv?: string
}

export interface TiaFilesystemArtifactOptions {
  group?: string
  paths?: string[]
}

export interface TiaHttpManifestOptions {
  authorizationScheme?: string
  maxArtifacts?: number
  name?: string
  tokenEnv?: string
  url: string
}

export interface TiaGitLabCiOptions {
  apiUrl?: string
  branch?: string
  jobName?: string
  maxPipelines?: number
  pipelineId?: number | string
  projectId?: number | string
  tokenHeader?: 'JOB-TOKEN' | 'PRIVATE-TOKEN'
  tokenEnv?: string
}

export interface TiaArtifactProviderContext {
  fingerprint: string
  root?: string
  runner?: string
}

export interface TiaArtifactCandidate {
  graph: string | unknown
  group?: number | string
  id: number | string
}

export interface TiaArtifactProvider {
  name: string
  load(
    context: TiaArtifactProviderContext,
  ):
    | Promise<TiaArtifactCandidate | TiaArtifactCandidate[] | null>
    | TiaArtifactCandidate
    | TiaArtifactCandidate[]
    | null
}

export type TiaArtifactSource =
  | TiaArtifactProvider
  | ({ provider: 'filesystem' } & TiaFilesystemArtifactOptions)
  | ({ provider: 'github-actions' } & TiaGitHubActionsOptions)
  | ({ provider: 'gitlab-ci' } & TiaGitLabCiOptions)
  | ({ provider: 'http-manifest' } & TiaHttpManifestOptions)
