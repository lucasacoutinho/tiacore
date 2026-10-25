import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['test/fixtures/**'],
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/support/hermetic-env.ts'],
    // Integration tests spawn real Vitest, Node, Bun and Playwright processes.
    testTimeout: 120_000,
  },
})
