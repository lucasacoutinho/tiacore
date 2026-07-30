import { defineConfig } from 'vitest/config'
import { tia } from '@usescherie/tiacore'

const native = process.env.TIA_COVERAGE_MODE === 'native'

export default defineConfig({
  plugins: native ? [] : [tia({ log: true })],
  test: {
    coverage: {
      clean: process.env.TIA_COVERAGE_CLEAN !== '0',
      enabled: true,
      exclude: ['src/excluded.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reportOnFailure:
        process.env.TIA_COVERAGE_REPORT_ON_FAILURE === '1',
      reporter: [
        ['json', { file: 'coverage-final.json' }],
        ['json-summary', { file: 'coverage-summary.json' }],
        ['html', { subdir: 'html' }],
      ],
      watermarks: {
        branches: [0, 100],
        functions: [0, 100],
        lines: [0, 100],
        statements: [0, 100],
      },
    },
    include: ['test/**/*.test.ts'],
  },
})
