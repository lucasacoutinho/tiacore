import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['test/fixtures/**'],
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/support/hermetic-env.ts'],
    // Integration tests and their setup hooks spawn real Vitest, Node, Bun
    // and Playwright processes.
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
})
