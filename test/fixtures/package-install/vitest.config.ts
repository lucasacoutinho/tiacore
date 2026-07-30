import { defineConfig } from 'vitest/config'
import { tia } from 'tiajs'

export default defineConfig({
  plugins: [tia({ log: true })],
  test: {
    include: ['test/**/*.test.ts'],
  },
})
