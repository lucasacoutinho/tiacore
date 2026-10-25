// What the Vitest main process and its workers exchange: the selection the
// plugin provides to every project, and the metadata the worker setup writes
// on tasks for the reporter. Plain TypeScript; the worker side imports it.
import type { ProbeModuleWindow, ProbeTestWindow } from '../../probe/types.ts'

export const TIA_META_KEY = '__tiacore__'
export const TIA_REPLAY_META_KEY = '__tiacore_replay__'
export const TIA_SELECTION_KEY = '__tiacore_selection__'
export const TIA_TEST_META_KEY = '__tiacore_test__'
export const TIA_CACHED_META_KEY = '__tiacore_cached__'

export interface TiaTestSelection {
  /** How Vitest sequences hooks; `parallel` hooks cannot bound a test body. */
  hooks: 'list' | 'parallel' | 'stack'
  mode: 'all' | 'tests'
  testIds: string[]
  wholeTestFiles: string[]
}

/** Coverage outside every test body of one module, and the files it touched. */
export type TiaModuleMeta = ProbeModuleWindow

/** Coverage inside one test body, and the files it touched. */
export type TiaTestMeta = ProbeTestWindow
