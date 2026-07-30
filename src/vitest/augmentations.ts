import type {
  TiaModuleMeta,
  TiaTestMeta,
  TiaTestSelection,
} from '../shared/types.js'

declare module '@vitest/runner' {
  interface TaskMeta {
    __tiacore_cached__?: boolean
    __tiacore__?: TiaModuleMeta
    __tiacore_replay__?: boolean
    __tiacore_test__?: TiaTestMeta
  }
}

declare module 'vitest' {
  interface ProvidedContext {
    __tiacore_selection__: TiaTestSelection
  }
}
