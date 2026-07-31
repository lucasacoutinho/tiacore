import { resolve } from 'node:path'

import { normalizeProtocolPath, normalizeProtocolPaths } from '../protocol/paths.js'
import { TiaCore, type TiaObservation } from '../engine/run.js'
import type { CachedTestResult, RunPlan } from '../engine/types.js'
import type {
  TiaAdapterCatalog,
  TiaAdapterDefinition,
  TiaAdapterExecution,
  TiaAdapterOptions,
  TiaAdapterResult,
  TiaAdapterSelectedTest,
  TiaAdapterTest,
} from './types.js'
import { TIA_TYPESCRIPT_ADAPTER_VERSION } from './types.js'

const ADAPTER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/
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

function normalizeCatalog<Metadata>(
  catalog: TiaAdapterCatalog<Metadata>,
): Required<Pick<TiaAdapterCatalog<Metadata>, 'files' | 'tests'>> &
  Pick<TiaAdapterCatalog<Metadata>, 'fingerprint'> {
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
    tests: tests.sort((left, right) => left.id.localeCompare(right.id)),
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

function selectedTests<Metadata>(
  plan: RunPlan,
  tests: TiaAdapterTest<Metadata>[],
): TiaAdapterSelectedTest<Metadata>[] {
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
      if (previous !== undefined) {
        selected.set(id, baselineTest(previous))
      }
    }
  }

  return [...selected.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
}

function normalizeObservation(observation: TiaObservation): TiaObservation {
  if (!['failed', 'passed', 'skipped'].includes(observation.state)) {
    throw new Error(`TIA adapter observation has an invalid state: ${observation.id}`)
  }
  if (
    observation.duration !== undefined &&
    (!Number.isFinite(observation.duration) || observation.duration < 0)
  ) {
    throw new Error(`TIA adapter observation has an invalid duration: ${observation.id}`)
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
  selected: TiaAdapterSelectedTest[],
  execution: TiaAdapterExecution,
): boolean {
  const observed = new Set(
    execution.observations.map((observation) => observation.id),
  )
  return (
    execution.complete &&
    selected.every((test) => observed.has(test.id))
  )
}

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
    if (new Set(definition.features ?? []).size !== (definition.features ?? []).length) {
      throw new Error('TIA adapter features contain duplicates')
    }
    const unsupportedFeature = (definition.features ?? []).find(
      (feature) => !ADAPTER_FEATURES.has(feature),
    )
    if (unsupportedFeature !== undefined) {
      throw new Error(`unsupported TIA adapter feature: ${unsupportedFeature}`)
    }
    this.definition = definition
    this.options = options
  }

  async run(): Promise<TiaAdapterResult> {
    const root = resolve(this.options.root ?? process.cwd())
    const catalog = normalizeCatalog(
      await this.definition.discover({ root }),
    )
    const testFiles = normalizeProtocolPaths(
      catalog.tests.map((test) => test.file),
    )
    const core = new TiaCore({
      ...(this.options.artifacts === undefined
        ? {}
        : { artifacts: this.options.artifacts }),
      ...(this.options.artifactTrust === undefined
        ? {}
        : { artifactTrust: this.options.artifactTrust }),
      ...(this.options.cacheDir === undefined
        ? {}
        : { cacheDir: this.options.cacheDir }),
      ...(this.options.exclude === undefined
        ? {}
        : { exclude: this.options.exclude }),
      files: normalizeProtocolPaths([...catalog.files, ...testFiles]),
      fingerprint: JSON.stringify({
        adapterApi: TIA_TYPESCRIPT_ADAPTER_VERSION,
        adapterVersion: this.definition.version,
        catalog: catalog.fingerprint ?? '',
        features: [...(this.definition.features ?? [])].sort(),
      }),
      ...(this.options.fresh === undefined
        ? {}
        : { fresh: this.options.fresh }),
      ...(this.options.ignoreChanges === undefined
        ? {}
        : { ignoreChanges: this.options.ignoreChanges }),
      ...(this.options.include === undefined
        ? {}
        : { include: this.options.include }),
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
      ...(this.options.onUnknownChange === undefined
        ? {}
        : { onUnknownChange: this.options.onUnknownChange }),
      ...(this.options.replayAdapters === undefined
        ? {}
        : { replayAdapters: this.options.replayAdapters }),
      root,
      runner: this.definition.name,
      testFiles,
    })
    const plan = await core.prepare()
    const selected = selectedTests(plan, catalog.tests)
    const defaultWholeFiles =
      plan.mode === 'record' ? testFiles : plan.wholeTestFiles

    if (this.options.log ?? true) {
      console.log(
        `TIA ${this.definition.name}: ${plan.reason}; ${selected.length} selected, ${plan.replayedTests} replayed.`,
      )
    }

    const execution = selected.length === 0
      ? { complete: true, observations: [] }
      : normalizeExecution(await this.definition.execute({
          plan: structuredClone(plan),
          root,
          tests: selected,
          wholeTestFiles: [...defaultWholeFiles],
        }))
    const complete = completeSelection(selected, execution)
    const wholeFiles = normalizeProtocolPaths([
      ...defaultWholeFiles,
      ...(execution.fullyExecutedFiles ?? []),
    ])
    const graph = complete
      ? await core.commit(execution.observations, wholeFiles)
      : null
    const success = complete && execution.observations.every(
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

export function tia<Metadata = unknown>(
  definition: TiaAdapterDefinition<Metadata>,
  options: TiaAdapterOptions = {},
): TiaAdapter<Metadata> {
  return new TiaAdapter(definition, options)
}
