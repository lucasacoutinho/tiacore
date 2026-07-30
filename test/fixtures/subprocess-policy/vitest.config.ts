import { defineConfig } from 'vitest/config'
import { tia } from 'tiajs'

export default defineConfig({
  plugins: [
    tia({
      coverage: {
        include: ['src/**/*.{mjs,ts}'],
        reporters: ['json'],
      },
      log: true,
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
})
