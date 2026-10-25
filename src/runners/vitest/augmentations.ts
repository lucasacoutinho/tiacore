import type {
  TiaModuleMeta,
  TiaTestMeta,
  TiaTestSelection,
} from './protocol.ts'

interface TiaTaskMeta {
  __tiacore_cached__?: boolean
  __tiacore__?: TiaModuleMeta
  __tiacore_replay__?: boolean
  __tiacore_test__?: TiaTestMeta
}

// Vitest 4 declares TaskMeta in @vitest/runner, and an augmentation of the
// re-export from vitest does not merge. Vitest 5 folds @vitest/runner into
// vitest, so this block names a missing module there.
// @ts-ignore TS2664 under Vitest 5
declare module '@vitest/runner' {
  interface TaskMeta extends TiaTaskMeta {}
}

declare module 'vitest' {
  interface TaskMeta extends TiaTaskMeta {}

  interface ProvidedContext {
    __tiacore_selection__: TiaTestSelection
  }
}
