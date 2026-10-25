import { resolve } from 'node:path'

import { byCodeUnit } from '../../core/canonical.ts'
import type { CachedTestResult, RunPlan } from '../../core/runtime.ts'
import { TiaCore, type TiaObservation } from '../../engine/core.ts'
import {
  normalizeProtocolPath,
  normalizeProtocolPaths,
} from '../../engine/plan/protocol.ts'
import {
  TIA_TYPESCRIPT_ADAPTER_VERSION,
  type TiaAdapterCatalog,
  type TiaAdapterDefinition,
  type TiaAdapterExecution,
  type TiaAdapterOptions,
  type TiaAdapterResult,
  type TiaAdapterSelectedTest,
  type TiaAdapterTest,
} from './types.ts'

const ADAPTER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/u
const ADAPTER_FEATURES = new Set([
  'cached-outcomes',
  'parallelism',
  'subprocess-observation',
  'worktrees',
])

function nonEmpty(value: string, label: string): string {
  if (value.trim() === '' || value.length > 8_192) {
    throw new Error(`${label} must be between 1 and 8192 characters`)
  }
  return value
}

function normalizeTest<Metadata>(
  test: TiaAdapterTest<Metadata>,
): TiaAdapterTest<Metadata> {
  return {
    ...(test.data === undefined ? {} : { data: test.data }),
    file: normalizeProtocolPath(test.file),
    fullName: nonEmpty(test.fullName, 'TIA adapter test name'),
    id: nonEmpty(test.id, 'TIA adapter test id'),
  }
}

interface NormalizedCatalog<Metadata> {
  readonly files: string[]
  readonly fingerprint?: string
  readonly tests: Array<TiaAdapterTest<Metadata>>
}

function normalizeCatalog<Metadata>(
  catalog: TiaAdapterCatalog<Metadata>,
): NormalizedCatalog<Metadata> {
  if (!Array.isArray(catalog.tests)) {
    throw new Error('TIA adapter discovery must return a test array')
  }
  const tests = catalog.tests.map(normalizeTest)
  if (new Set(tests.map((test) => test.id)).size !== tests.length) {
    throw new Error('TIA adapter discovery returned duplicate test ids')
  }
  if (
    catalog.fingerprint !== undefined &&
    (catalog.fingerprint === '' || catalog.fingerprint.length > 8_192)
  ) {
    throw new Error('TIA adapter catalog fingerprint is invalid')
  }
  return {
    files: normalizeProtocolPaths(catalog.files ?? []),
    ...(catalog.fingerprint === undefined
      ? {}
      : { fingerprint: catalog.fingerprint }),
    tests: tests.sort((left, right) => byCodeUnit(left.id, right.id)),
  }
}

function baselineTest<Metadata>(
  result: CachedTestResult,
): TiaAdapterSelectedTest<Metadata> {
  return {
    file: result.file,
    fullName: result.fullName,
    id: result.id,
    source: 'baseline',
  }
}

/**
 * The tests this run executes: every catalog test when recording; when
 * replaying, the catalog tests of whole-file fallbacks plus each affected id,
 * from the catalog when it is still there and from the stored graph (source
 * `baseline`) when it is not.
 */
function selectedTests<Metadata>(
  plan: RunPlan,
  tests: Array<TiaAdapterTest<Metadata>>,
): Array<TiaAdapterSelectedTest<Metadata>> {
  const catalog = new Map(tests.map((test) => [test.id, test]))
  const selected = new Map<string, TiaAdapterSelectedTest<Metadata>>()
  const addCatalogTest = (test: TiaAdapterTest<Metadata>): void => {
    selected.set(test.id, { ...test, source: 'catalog' })
  }

  if (plan.mode === 'record') {
    for (const test of tests) addCatalogTest(test)
  } else {
    const wholeFiles = new Set(plan.wholeTestFiles)
    for (const test of tests) {
      if (wholeFiles.has(test.file)) addCatalogTest(test)
    }
    for (const id of plan.affectedTestIds) {
      const current = catalog.get(id)
      if (current !== undefined) {
        addCatalogTest(current)
        continue
      }
      const previous = plan.graph?.results[id]
      if (previous !== undefined) selected.set(id, baselineTest(previous))
    }
  }

  return [...selected.values()].sort((left, right) =>
    byCodeUnit(left.id, right.id),
  )
}

function normalizeObservation(observation: TiaObservation): TiaObservation {
  if (!['failed', 'passed', 'skipped'].includes(observation.state)) {
    throw new Error(
      `TIA adapter observation has an invalid state: ${observation.id}`,
    )
  }
  if (
    observation.duration !== undefined &&
    (!Number.isFinite(observation.duration) || observation.duration < 0)
  ) {
    throw new Error(
      `TIA adapter observation has an invalid duration: ${observation.id}`,
    )
  }
  return {
    ...(observation.duration === undefined
      ? {}
      : { duration: observation.duration }),
    file: normalizeProtocolPath(observation.file),
    files: normalizeProtocolPaths(observation.files),
    fullName: nonEmpty(observation.fullName, 'TIA adapter observation name'),
    id: nonEmpty(observation.id, 'TIA adapter observation id'),
    state: observation.state,
  }
}

function normalizeExecution(
  execution: TiaAdapterExecution,
): TiaAdapterExecution {
  if (typeof execution.complete !== 'boolean') {
    throw new Error('TIA adapter execution must declare completeness')
  }
  if (!Array.isArray(execution.observations)) {
    throw new Error('TIA adapter execution must return observations')
  }
  const observations = execution.observations.map(normalizeObservation)
  if (
    new Set(observations.map((observation) => observation.id)).size !==
    observations.length
  ) {
    throw new Error('TIA adapter execution returned duplicate observation ids')
  }
  return {
    complete: execution.complete,
    ...(execution.fullyExecutedFiles === undefined
      ? {}
      : {
          fullyExecutedFiles: normalizeProtocolPaths(
            execution.fullyExecutedFiles,
          ),
        }),
    observations,
  }
}

function completeSelection(
  selected: readonly TiaAdapterSelectedTest[],
  execution: TiaAdapterExecution,
): boolean {
  const observed = new Set(
    execution.observations.map((observation) => observation.id),
  )
  return execution.complete && selected.every((test) => observed.has(test.id))
}

/**
 * Runs a custom TypeScript adapter: discover the catalog, plan against the
 * stored graph, hand the selected tests to the adapter's `execute`, and commit
 * the observations only when the adapter vouches for the whole selection.
 */
export class TiaAdapter<Metadata = unknown> {
  private readonly definition: TiaAdapterDefinition<Metadata>
  private readonly options: TiaAdapterOptions

  constructor(
    definition: TiaAdapterDefinition<Metadata>,
    options: TiaAdapterOptions = {},
  ) {
    if (definition.apiVersion !== TIA_TYPESCRIPT_ADAPTER_VERSION) {
      throw new Error(
        `unsupported TIA TypeScript adapter version: ${String(definition.apiVersion)}`,
      )
    }
    if (!ADAPTER_NAME_PATTERN.test(definition.name)) {
      throw new Error('TIA adapter name must be a safe lowercase cache key')
    }
    nonEmpty(definition.version, 'TIA adapter version')
    const features = definition.features ?? []
    if (new Set(features).size !== features.length) {
      throw new Error('TIA adapter features contain duplicates')
    }
    const unsupportedFeature = features.find(
      (feature) => !ADAPTER_FEATURES.has(feature),
    )
    if (unsupportedFeature !== undefined) {
      throw new Error(`unsupported TIA adapter feature: ${unsupportedFeature}`)
    }
    this.definition = definition
    this.options = options
  }

  async run(): Promise<TiaAdapterResult> {
    const { options } = this
    const root = resolve(options.root ?? process.cwd())
    const catalog = normalizeCatalog(await this.definition.discover({ root }))
    const testFiles = normalizeProtocolPaths(
      catalog.tests.map((test) => test.file),
    )
    const core = new TiaCore({
      ...(options.artifacts === undefined
        ? {}
        : { artifacts: options.artifacts }),
      ...(options.artifactTrust === undefined
        ? {}
        : { artifactTrust: options.artifactTrust }),
      ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      files: normalizeProtocolPaths([...catalog.files, ...testFiles]),
      fingerprint: JSON.stringify({
        adapterApi: TIA_TYPESCRIPT_ADAPTER_VERSION,
        adapterVersion: this.definition.version,
        catalog: catalog.fingerprint ?? '',
        features: [...(this.definition.features ?? [])].sort(byCodeUnit),
      }),
      ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
      ...(options.ignoreChanges === undefined
        ? {}
        : { ignoreChanges: options.ignoreChanges }),
      ...(options.include === undefined ? {} : { include: options.include }),
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.onUnknownChange === undefined
        ? {}
        : { onUnknownChange: options.onUnknownChange }),
      ...(options.replayAdapters === undefined
        ? {}
        : { replayAdapters: options.replayAdapters }),
      root,
      runner: this.definition.name,
      testFiles,
    })
    const plan = await core.prepare()
    const selected = selectedTests(plan, catalog.tests)
    const defaultWholeFiles =
      plan.mode === 'record' ? testFiles : plan.wholeTestFiles

    if (options.log ?? true) {
      console.log(
        `TIA ${this.definition.name}: ${plan.reason}; ${selected.length} selected, ${plan.replayedTests} replayed.`,
      )
    }

    const execution: TiaAdapterExecution =
      selected.length === 0
        ? { complete: true, observations: [] }
        : normalizeExecution(
            await this.definition.execute({
              plan: structuredClone(plan),
              root,
              tests: selected,
              wholeTestFiles: [...defaultWholeFiles],
            }),
          )
    const complete = completeSelection(selected, execution)
    const wholeFiles = normalizeProtocolPaths([
      ...defaultWholeFiles,
      ...(execution.fullyExecutedFiles ?? []),
    ])
    const graph = complete
      ? await core.commit(execution.observations, wholeFiles)
      : null
    const success =
      complete &&
      execution.observations.every(
        (observation) => observation.state !== 'failed',
      )

    return {
      complete,
      executedTests: execution.observations,
      graph,
      graphSaved: graph !== null,
      plan,
      replayedTests: plan.replayedTests,
      selectedTests: selected.length,
      success,
    }
  }
}

/** Creates a runner for a custom TypeScript adapter. */
export function tia<Metadata = unknown>(
  definition: TiaAdapterDefinition<Metadata>,
  options: TiaAdapterOptions = {},
): TiaAdapter<Metadata> {
  return new TiaAdapter(definition, options)
}
