import { defineConfig } from 'vitest/config'

import { tia } from './src/index.js'

export default defineConfig({
  plugins: [tia()],
  test: {
    coverage: {
      enabled: false,
    },
    exclude: ['test/fixtures/**'],
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
