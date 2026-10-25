import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'
import * as Redacted from 'effect/Redacted'
import picomatch from 'picomatch'

import {
  MAX_ARTIFACT_ARCHIVE_BYTES,
  type TiaArtifactCandidate,
  type TiaArtifactProvider,
  type TiaArtifactProviderContext,
  type TiaGitLabCiOptions,
} from '../../core/artifacts.ts'
import { runPromise } from '../../host/runtime.ts'
import { readArtifactArchive } from './archive.ts'
import { type Fetch, getBytes, getJson, MAX_LISTING_BYTES } from './http.ts'

interface GitLabJob {
  artifacts_file?: { filename?: string; size?: number }
  id: number
  name: string
  status: string
}

interface GitLabPipeline {
  id: number
  status: string
}

function isPipeline(value: unknown): value is GitLabPipeline {
  return (
    Predicate.isObject(value) &&
    typeof value['id'] === 'number' &&
    typeof value['status'] === 'string'
  )
}

function isJob(value: unknown): value is GitLabJob {
  return (
    Predicate.isObject(value) &&
    typeof value['id'] === 'number' &&
    typeof value['name'] === 'string' &&
    typeof value['status'] === 'string'
  )
}

function headers(options: TiaGitLabCiOptions): Record<string, string> {
  const raw = process.env[options.tokenEnv ?? 'CI_JOB_TOKEN']
  const token = raw === undefined ? undefined : Redacted.make(raw)
  const secret = token === undefined ? '' : Redacted.value(token)
  return secret === '' ? {} : { [options.tokenHeader ?? 'JOB-TOKEN']: secret }
}

export const loadGitLabArtifacts = Effect.fnUntraced(function* (
  context: TiaArtifactProviderContext,
  options: TiaGitLabCiOptions,
  request: Fetch,
) {
  const projectId = options.projectId ?? process.env['CI_PROJECT_ID']
  if (projectId === undefined || String(projectId).trim() === '') return null

  const apiUrl = (
    options.apiUrl ??
    process.env['CI_API_V4_URL'] ??
    'https://gitlab.com/api/v4'
  ).replace(/\/+$/u, '')
  const projectUrl = `${apiUrl}/projects/${encodeURIComponent(String(projectId))}`
  const requestHeaders = headers(options)
  const json = (url: string) =>
    getJson(request, url, requestHeaders, MAX_LISTING_BYTES)

  let candidatePipelines: GitLabPipeline[]
  if (options.pipelineId === undefined) {
    const query = new URLSearchParams({
      order_by: 'updated_at',
      per_page: String(Math.max(1, Math.min(100, options.maxPipelines ?? 20))),
      sort: 'desc',
      status: 'success',
    })
    const branch = options.branch ?? process.env['CI_COMMIT_REF_NAME']
    if (branch !== undefined && branch !== '') query.set('ref', branch)
    const listed = yield* json(`${projectUrl}/pipelines?${query.toString()}`)
    candidatePipelines = Array.isArray(listed) ? listed.filter(isPipeline) : []
  } else {
    const id = Number(String(options.pipelineId))
    candidatePipelines = Number.isSafeInteger(id)
      ? [{ id, status: 'success' }]
      : []
  }

  const currentPipeline = process.env['CI_PIPELINE_ID']
  const matchesJob = picomatch(options.jobName ?? 'tiacore')
  const candidates: TiaArtifactCandidate[] = []
  for (const pipeline of candidatePipelines) {
    if (
      pipeline.status !== 'success' ||
      String(pipeline.id) === currentPipeline
    ) {
      continue
    }
    const listedJobs = yield* json(
      `${projectUrl}/pipelines/${pipeline.id}/jobs?scope%5B%5D=success&per_page=100`,
    )
    const pipelineJobs = (Array.isArray(listedJobs) ? listedJobs : [])
      .filter(isJob)
      .filter(
        (job) =>
          job.status === 'success' &&
          matchesJob(job.name) &&
          typeof job.artifacts_file?.filename === 'string' &&
          (job.artifacts_file.size ?? 0) <= MAX_ARTIFACT_ARCHIVE_BYTES,
      )
    for (const job of pipelineJobs) {
      const archive = yield* getBytes(
        request,
        `${projectUrl}/jobs/${job.id}/artifacts`,
        requestHeaders,
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
})

export function createGitLabCiArtifactProvider(
  options: TiaGitLabCiOptions,
  request: Fetch = globalThis.fetch,
): TiaArtifactProvider {
  return {
    name: 'GitLab CI',
    load: (context) =>
      runPromise(loadGitLabArtifacts(context, options, request)),
  }
}
