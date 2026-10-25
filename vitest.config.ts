import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['test/fixtures/**'],
    include: ['test/**/*.test.ts'],
    // Integration tests spawn real Vitest, Node, Bun and Playwright processes.
    testTimeout: 120_000,
  },
})
