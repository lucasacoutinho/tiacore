import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import {
  dirname,
  join,
} from 'node:path'

import { GRAPH_SCHEMA_VERSION } from '../../shared/constants.js'
import type { TiaRuntimeGraph } from '../types.js'

export function graphPath(cacheDir: string): string {
  return join(cacheDir, 'graph.json')
}

export function graphDigest(graph: TiaRuntimeGraph | null): string | null {
  return graph === null
    ? null
    : createHash('sha256').update(JSON.stringify(graph)).digest('hex')
}

export function readGraph(cacheDir: string): TiaRuntimeGraph | null {
  try {
    return parseGraph(readFileSync(graphPath(cacheDir), 'utf8'))
  } catch {
    return null
  }
}

export function parseGraph(source: string | unknown): TiaRuntimeGraph | null {
  try {
    const value =
      typeof source === 'string'
        ? (JSON.parse(source) as unknown)
        : source

    if (!isGraph(value)) {
      return null
    }

    if (value.schema === 1 || value.schema === 2) {
      return {
        ...value,
        collectionCoverage: {},
        coverageComplete: false,
        schema: GRAPH_SCHEMA_VERSION,
        testCoverage: {},
        testEdges: value.schema === 1 ? {} : value.testEdges,
      } as TiaRuntimeGraph
    }

    return value as unknown as TiaRuntimeGraph
  } catch {
    return null
  }
}

export function writeGraph(cacheDir: string, graph: TiaRuntimeGraph): void {
  const target = graphPath(cacheDir)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`

  mkdirSync(dirname(target), { recursive: true })
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify(graph, null, 2)}\n`,
      'utf8',
    )
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

interface GraphLockOwner {
  createdAt: number
  hostname: string
  pid: number
  token: string
}

export interface GraphCommitResult {
  graph: TiaRuntimeGraph | null
  status: 'committed' | 'conflict' | 'merged'
}

export interface GraphCommitOptions {
  expected: TiaRuntimeGraph | null
  expectedDigest: string | null
  graph: TiaRuntimeGraph
  lockTimeoutMs?: number
  staleLockMs?: number
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

function lockPath(cacheDir: string): string {
  return join(cacheDir, 'graph.lock')
}

function lockOwner(path: string): GraphLockOwner | null {
  try {
    const value = JSON.parse(
      readFileSync(join(path, 'owner.json'), 'utf8'),
    ) as Partial<GraphLockOwner>
    return (
      typeof value.createdAt === 'number' &&
      typeof value.hostname === 'string' &&
      typeof value.pid === 'number' &&
      typeof value.token === 'string'
    )
      ? value as GraphLockOwner
      : null
  } catch {
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EPERM'
    )
  }
}

function staleLock(path: string, staleAfter: number): boolean {
  try {
    const owner = lockOwner(path)
    const age =
      Date.now() -
      (owner?.createdAt ?? statSync(path).mtimeMs)
    if (owner?.hostname === hostname() && !processAlive(owner.pid)) {
      return true
    }
    return age >= staleAfter
  } catch {
    return false
  }
}

async function acquireLock(
  cacheDir: string,
  timeout: number,
  staleAfter: number,
): Promise<GraphLockOwner | null> {
  const path = lockPath(cacheDir)
  const started = Date.now()
  mkdirSync(cacheDir, { recursive: true })

  while (Date.now() - started < timeout) {
    const owner: GraphLockOwner = {
      createdAt: Date.now(),
      hostname: hostname(),
      pid: process.pid,
      token: randomUUID(),
    }
    try {
      mkdirSync(path)
      writeFileSync(
        join(path, 'owner.json'),
        `${JSON.stringify(owner)}\n`,
        'utf8',
      )
      return owner
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      ) {
        throw error
      }
    }

    if (staleLock(path, staleAfter)) {
      rmSync(path, { force: true, recursive: true })
      continue
    }

    await wait(20 + Math.floor(Math.random() * 30))
  }

  return null
}

function releaseLock(cacheDir: string, owner: GraphLockOwner): void {
  const path = lockPath(cacheDir)
  if (lockOwner(path)?.token === owner.token) {
    rmSync(path, { force: true, recursive: true })
  }
}

function cleanAbandonedWrites(cacheDir: string): void {
  try {
    for (const entry of readdirSync(cacheDir)) {
      if (
        /^graph\.json\.\d+\.[\da-f-]{36}\.tmp$/i.test(entry)
      ) {
        rmSync(join(cacheDir, entry), { force: true })
      }
    }
  } catch {
    // A missing cache directory or a concurrently removed orphan is benign.
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameResult(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) {
    return same(left, right)
  }
  const { duration: _leftDuration, ...leftValue } = left
  const { duration: _rightDuration, ...rightValue } = right
  return same(leftValue, rightValue)
}

function mergeChangedRecord(
  expected: Record<string, unknown>,
  current: Record<string, unknown>,
  proposed: Record<string, unknown>,
  equivalent: (left: unknown, right: unknown) => boolean = same,
): boolean {
  const keys = new Set([
    ...Object.keys(expected),
    ...Object.keys(current),
    ...Object.keys(proposed),
  ])

  for (const key of keys) {
    const before = expected[key]
    const ours = proposed[key]
    const theirs = current[key]
    const oursChanged = !equivalent(ours, before)
    if (!oursChanged) {
      continue
    }
    const theirsChanged = !equivalent(theirs, before)
    if (theirsChanged && !equivalent(ours, theirs)) {
      return false
    }
    if (ours === undefined) {
      delete current[key]
    } else {
      current[key] = structuredClone(ours)
    }
  }

  return true
}

function compatibleCommit(left: TiaRuntimeGraph, right: TiaRuntimeGraph): boolean {
  return (
    left.schema === right.schema &&
    left.fingerprint === right.fingerprint &&
    left.complete === right.complete &&
    left.coverageComplete === right.coverageComplete &&
    same(left.baseline, right.baseline) &&
    same(left.partition, right.partition)
  )
}

function mergeConcurrentGraphs(
  expected: TiaRuntimeGraph | null,
  current: TiaRuntimeGraph,
  proposed: TiaRuntimeGraph,
): TiaRuntimeGraph | null {
  if (!compatibleCommit(current, proposed)) {
    return null
  }

  const before = expected ?? {
    collectionCoverage: {},
    edges: {},
    results: {},
    testCoverage: {},
    testEdges: {},
  }
  const merged = structuredClone(current)
  const records = [
    ['collectionCoverage', same],
    ['edges', same],
    ['results', sameResult],
    ['testCoverage', same],
    ['testEdges', same],
  ] as const

  for (const [key, equivalent] of records) {
    if (
      !mergeChangedRecord(
        before[key] as Record<string, unknown>,
        merged[key] as Record<string, unknown>,
        proposed[key] as Record<string, unknown>,
        equivalent,
      )
    ) {
      return null
    }
  }

  merged.updatedAt =
    proposed.updatedAt > current.updatedAt
      ? proposed.updatedAt
      : current.updatedAt
  return merged
}

export async function commitGraph(
  cacheDir: string,
  options: GraphCommitOptions,
): Promise<GraphCommitResult> {
  if (graphDigest(options.expected) !== options.expectedDigest) {
    return { graph: readGraph(cacheDir), status: 'conflict' }
  }

  const owner = await acquireLock(
    cacheDir,
    options.lockTimeoutMs ?? 10_000,
    options.staleLockMs ?? 120_000,
  )
  if (owner === null) {
    return { graph: readGraph(cacheDir), status: 'conflict' }
  }

  try {
    cleanAbandonedWrites(cacheDir)
    const current = readGraph(cacheDir)
    if (graphDigest(current) === options.expectedDigest) {
      writeGraph(cacheDir, options.graph)
      return {
        graph: structuredClone(options.graph),
        status: 'committed',
      }
    }

    if (current === null) {
      return { graph: null, status: 'conflict' }
    }
    const merged = mergeConcurrentGraphs(
      options.expected,
      current,
      options.graph,
    )
    if (merged === null) {
      return { graph: current, status: 'conflict' }
    }

    writeGraph(cacheDir, merged)
    return { graph: merged, status: 'merged' }
  } finally {
    releaseLock(cacheDir, owner)
  }
}

export function purgeGraph(cacheDir: string): void {
  rmSync(graphPath(cacheDir), { force: true })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGraph(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false
  }

  if (
    (value.schema !== 1 &&
      value.schema !== 2 &&
      value.schema !== GRAPH_SCHEMA_VERSION) ||
    typeof value.complete !== 'boolean' ||
    typeof value.fingerprint !== 'string' ||
    !isRecord(value.baseline) ||
    typeof value.baseline.sha !== 'string' ||
    (value.baseline.source !== undefined &&
      value.baseline.source !== 'filesystem' &&
      value.baseline.source !== 'git') ||
    !isRecord(value.baseline.workingTree) ||
    !isRecord(value.edges) ||
    !isRecord(value.results) ||
    typeof value.updatedAt !== 'string'
  ) {
    return false
  }

  const workingTree = value.baseline.workingTree
  const edges = value.edges
  const results = value.results
  const testEdges = value.testEdges
  const collectionCoverage = value.collectionCoverage
  const testCoverage = value.testCoverage
  const partition = value.partition

  return (
    Object.values(workingTree).every((hash) => typeof hash === 'string') &&
    Object.values(edges).every(
      (files) =>
        Array.isArray(files) &&
        files.every((file) => typeof file === 'string'),
    ) &&
    Object.values(results).every(
      (result) =>
        isRecord(result) &&
        typeof result.id === 'string' &&
        typeof result.file === 'string' &&
        typeof result.fullName === 'string' &&
        (result.state === 'passed' ||
          result.state === 'failed' ||
          result.state === 'skipped') &&
        (result.duration === undefined || typeof result.duration === 'number'),
    ) &&
    (value.schema === 1 ||
      (isRecord(testEdges) &&
        Object.values(testEdges).every(
          (edge) =>
            isRecord(edge) &&
            typeof edge.file === 'string' &&
            Array.isArray(edge.files) &&
            edge.files.every((file) => typeof file === 'string'),
        ))) &&
    (value.schema !== GRAPH_SCHEMA_VERSION ||
      (typeof value.coverageComplete === 'boolean' &&
        isRecord(collectionCoverage) &&
        Object.values(collectionCoverage).every(isRecord) &&
        isRecord(testCoverage) &&
        Object.values(testCoverage).every(isRecord))) &&
    (partition === undefined ||
      (isRecord(partition) &&
        (partition.group === undefined ||
          typeof partition.group === 'string') &&
        Number.isInteger(partition.index) &&
        Number.isInteger(partition.total) &&
        (partition.index as number) >= 1 &&
        (partition.total as number) >= (partition.index as number)))
  )
}
