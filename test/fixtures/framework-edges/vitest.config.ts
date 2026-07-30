import { defineConfig } from 'vitest/config'
import { tia } from 'tiajs'

export default defineConfig({
  plugins: [
    tia({
      frameworks: {
        database: true,
        views: true,
      },
      log: true,
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
})
