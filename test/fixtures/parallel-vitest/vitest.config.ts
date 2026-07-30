import { defineConfig } from 'vitest/config'

import { tia } from '@usescherie/tiacore'

export default defineConfig({
  plugins: [tia({ log: true })],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
  },
})
