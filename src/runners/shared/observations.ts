import type { RunPlan } from '../../core/runtime.ts'
import { byCodeUnit } from '../../core/canonical.ts'
import type { TiaObservation } from '../../engine/core.ts'
import { inheritedEnvironment } from '../../engine/process.ts'

/** Groups values by key, keeping first-seen key order and value order. */
export function groupBy<T, K>(
  values: readonly T[],
  key: (value: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const value of values) {
    const group = key(value)
    const items = groups.get(group)
    if (items === undefined) groups.set(group, [value])
    else items.push(value)
  }
  return groups
}

/**
 * The environment of a test file's child: ours without `NODE_TEST_CONTEXT`, so
 * a runner started inside `node --test` does not make its children report to
 * that run, plus `extra`.
 */
export function childEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  return inheritedEnvironment({ NODE_TEST_CONTEXT: undefined, ...extra })
}

/** The failed observation that stands for a test file that did not load or run. */
export function moduleFailureObservation(file: string): TiaObservation {
  return {
    file,
    files: [file],
    fullName: `${file} (module failure)`,
    id: `module:${file}`,
    state: 'failed',
  }
}

/**
 * The test files a commit treats as fully executed: the initial files, files
 * of module-failure observations, and (in replay) files of affected `module:`
 * results, so a retried module failure is cleared even when it now yields
 * different case ids.
 */
export function fullyExecutedFiles(
  plan: RunPlan,
  observations: readonly TiaObservation[],
  initial: readonly string[],
): string[] {
  const files = new Set(initial)
  for (const observation of observations) {
    if (observation.id === `module:${observation.file}`) {
      files.add(observation.file)
    }
  }
  if (plan.mode === 'replay' && plan.graph !== null) {
    for (const id of plan.affectedTestIds) {
      if (!id.startsWith('module:')) continue
      const result = plan.graph.results[id]
      if (result !== undefined) files.add(result.file)
    }
  }
  return [...files].sort(byCodeUnit)
}

/** An observation from a runner-reported case plus the files it depended on. */
export function observationOf(
  testCase: {
    readonly duration?: number | undefined
    readonly file: string
    readonly fullName: string
    readonly id: string
    readonly state: 'failed' | 'passed' | 'skipped'
  },
  files: readonly string[],
): TiaObservation {
  return {
    ...(testCase.duration === undefined ? {} : { duration: testCase.duration }),
    file: testCase.file,
    files: [...new Set(files)].sort(byCodeUnit),
    fullName: testCase.fullName,
    id: testCase.id,
    state: testCase.state,
  }
}
