import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    benchmark: {
      include: ['benchmark/**/*.bench.ts'],
    },
  },
})
