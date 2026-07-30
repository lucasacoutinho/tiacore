import { defineConfig } from 'vitest/config'
import { tia } from '@usescherie/tiacore'

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
