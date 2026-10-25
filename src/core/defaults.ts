// Defaults shared by every runtime adapter.

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

export const DEFAULT_CACHE_DIR = '.tia'

/** The port Effect's devtools clients and editor extensions connect to. */
export const DEFAULT_DEVTOOLS_PORT = 34_437
