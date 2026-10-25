export const GRAPH_SCHEMA_VERSION = 4
export const PLUGIN_VERSION = '1.2.1'
export const TIA_META_KEY = '__tiacore__'
export const TIA_REPLAY_META_KEY = '__tiacore_replay__'
export const TIA_SELECTION_KEY = '__tiacore_selection__'
export const TIA_TEST_META_KEY = '__tiacore_test__'

export const DEFAULT_INCLUDE = ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}']

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
]

export const TEST_FILE_PATTERN =
  /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec))\.(?:[cm]?[jt]sx?)$/

export const STRUCTURAL_FILE_PATTERN =
  /^(?:package\.json|(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)|(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json|(?:vite|vitest)(?:\.[^.]+)?\.config\.[cm]?[jt]s)$/
