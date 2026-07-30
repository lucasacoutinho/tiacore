export const GRAPH_SCHEMA_VERSION = 3;
export const PLUGIN_VERSION = '0.1.0';
export const TIA_META_KEY = '__tiajs__';
export const TIA_REPLAY_META_KEY = '__tiajs_replay__';
export const TIA_SELECTION_KEY = '__tiajs_selection__';
export const TIA_TEST_META_KEY = '__tiajs_test__';
export const DEFAULT_INCLUDE = ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'];
export const DEFAULT_EXCLUDE = [
    '**/node_modules/**',
    '**/.git/**',
    '**/.tia/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/*.{test,spec}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}',
    '**/__tests__/**',
    '**/__mocks__/**',
];
export const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec))\.(?:[cm]?[jt]sx?)$/;
export const STRUCTURAL_FILE_PATTERN = /^(?:package\.json|(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)|(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json|(?:vite|vitest)(?:\.[^.]+)?\.config\.[cm]?[jt]s)$/;
//# sourceMappingURL=constants.js.map