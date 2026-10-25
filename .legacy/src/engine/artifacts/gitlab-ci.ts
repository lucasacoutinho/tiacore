import picomatch from 'picomatch'

import {
  MAX_ARTIFACT_ARCHIVE_BYTES,
  readArtifactArchive,
  readBoundedResponse,
} from './archive.js'
import type {
  TiaArtifactCandidate,
  TiaArtifactProvider,
  TiaArtifactProviderContext,
  TiaGitLabCiOptions,
} from './types.js'

interface GitLabJob {
  artifacts_file?: {
    filename?: string
    size?: number
  }
  id: number
  name: string
  status: string
}

interface GitLabPipeline {
  id: number
  ref?: string
  status: string
}

function pipelines(value: unknown): GitLabPipeline[] {
  return Array.isArray(value)
    ? value.filter(
        (pipeline): pipeline is GitLabPipeline =>
          pipeline !== null &&
          typeof pipeline === 'object' &&
          typeof (pipeline as GitLabPipeline).id === 'number' &&
          typeof (pipeline as GitLabPipeline).status === 'string',
      )
    : []
}

function jobs(value: unknown): GitLabJob[] {
  return Array.isArray(value)
    ? value.filter(
        (job): job is GitLabJob =>
          job !== null &&
          typeof job === 'object' &&
          typeof (job as GitLabJob).id === 'number' &&
          typeof (job as GitLabJob).name === 'string' &&
          typeof (job as GitLabJob).status === 'string',
      )
    : []
}

function headers(options: TiaGitLabCiOptions): Record<string, string> {
  const token = process.env[options.tokenEnv ?? 'CI_JOB_TOKEN']
  return token === undefined || token === ''
    ? {}
    : { [options.tokenHeader ?? 'JOB-TOKEN']: token }
}

async function json(
  request: typeof globalThis.fetch,
  url: string,
  requestHeaders: Record<string, string>,
): Promise<unknown> {
  const response = await request(url, {
    headers: requestHeaders,
    redirect: 'follow',
  })
  return response.ok ? response.json() : null
}

async function loadGitLabArtifacts(
  context: TiaArtifactProviderContext,
  options: TiaGitLabCiOptions,
  request: typeof globalThis.fetch,
): Promise<TiaArtifactCandidate[] | null> {
  const projectId = options.projectId ?? process.env.CI_PROJECT_ID
  if (projectId === undefined || String(projectId).trim() === '') {
    return null
  }
  const apiUrl = (
    options.apiUrl ??
    process.env.CI_API_V4_URL ??
    'https://gitlab.com/api/v4'
  ).replace(/\/+$/u, '')
  const projectUrl = `${apiUrl}/projects/${encodeURIComponent(String(projectId))}`
  const requestHeaders = headers(options)
  const pipelineId =
    options.pipelineId === undefined ? null : String(options.pipelineId)
  let candidatePipelines: GitLabPipeline[]
  if (pipelineId === null) {
    const query = new URLSearchParams({
      order_by: 'updated_at',
      per_page: String(Math.max(1, Math.min(100, options.maxPipelines ?? 20))),
      sort: 'desc',
      status: 'success',
    })
    const branch = options.branch ?? process.env.CI_COMMIT_REF_NAME
    if (branch !== undefined && branch !== '') query.set('ref', branch)
    candidatePipelines = pipelines(
      await json(
        request,
        `${projectUrl}/pipelines?${query.toString()}`,
        requestHeaders,
      ),
    )
  } else {
    const id = Number(pipelineId)
    candidatePipelines = Number.isSafeInteger(id)
      ? [{ id, status: 'success' }]
      : []
  }

  const currentPipeline = process.env.CI_PIPELINE_ID
  const matchesJob = picomatch(options.jobName ?? 'tiacore')
  const candidates: TiaArtifactCandidate[] = []
  for (const pipeline of candidatePipelines) {
    if (
      pipeline.status !== 'success' ||
      String(pipeline.id) === currentPipeline
    ) {
      continue
    }
    const pipelineJobs = jobs(
      await json(
        request,
        `${projectUrl}/pipelines/${pipeline.id}/jobs?scope%5B%5D=success&per_page=100`,
        requestHeaders,
      ),
    ).filter(
      (job) =>
        job.status === 'success' &&
        matchesJob(job.name) &&
        typeof job.artifacts_file?.filename === 'string' &&
        (job.artifacts_file.size ?? 0) <= MAX_ARTIFACT_ARCHIVE_BYTES,
    )
    for (const job of pipelineJobs) {
      const response = await request(`${projectUrl}/jobs/${job.id}/artifacts`, {
        headers: requestHeaders,
        redirect: 'follow',
      })
      if (!response.ok) continue
      const archive = await readBoundedResponse(
        response,
        MAX_ARTIFACT_ARCHIVE_BYTES,
      )
      if (archive === null) continue
      const value = readArtifactArchive(archive, context.runner)
      if (value?.graph.fingerprint !== context.fingerprint) continue
      candidates.push({
        ...(value.attestation === undefined
          ? {}
          : { attestation: value.attestation }),
        graph: value.graph,
        graphSha256: value.graphSha256,
        group: pipeline.id,
        id: job.id,
      })
    }
  }
  return candidates.length === 0 ? null : candidates
}

export function createGitLabCiArtifactProvider(
  options: TiaGitLabCiOptions,
  request: typeof globalThis.fetch = globalThis.fetch,
): TiaArtifactProvider {
  return {
    name: 'GitLab CI',
    load: (context) => loadGitLabArtifacts(context, options, request),
  }
}
