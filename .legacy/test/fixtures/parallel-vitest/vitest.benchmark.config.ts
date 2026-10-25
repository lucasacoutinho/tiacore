import { defineConfig } from 'vitest/config'

import { tia } from '../../../dist/index.js'

export default defineConfig({
  plugins: [tia({ log: false })],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
  },
})
