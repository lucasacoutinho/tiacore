import type { TiaModuleMeta, TiaTestMeta, TiaTestSelection } from '../shared/types.js';
declare module '@vitest/runner' {
    interface TaskMeta {
        __tiajs_cached__?: boolean;
        __tiajs__?: TiaModuleMeta;
        __tiajs_replay__?: boolean;
        __tiajs_test__?: TiaTestMeta;
    }
}
declare module 'vitest' {
    interface ProvidedContext {
        __tiajs_selection__: TiaTestSelection;
    }
}
//# sourceMappingURL=augmentations.d.ts.map