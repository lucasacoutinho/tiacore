import { defineConfig } from 'vitest/config'

// Timing budgets against 1.x. They run one file at a time, apart from the
// correctness suite, so the other tests' load does not decide them.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['test/perf/**/*.perf.ts'],
    setupFiles: ['test/support/hermetic-env.ts'],
    testTimeout: 300_000,
  },
})
