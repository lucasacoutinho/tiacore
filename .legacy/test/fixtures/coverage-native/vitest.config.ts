import { defineConfig } from 'vitest/config'
import { tia } from '@lucasacoutinho/tiacore'

const strict = process.env.TIA_STRICT_COVERAGE === '1'

export default defineConfig({
  plugins: [tia({ log: true })],
  test: {
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: [
        ['json-summary', { file: 'tuple-summary.json' }],
        ['text', { skipFull: true }],
      ],
      thresholds: strict
        ? {
            100: true,
            perFile: true,
            'src/classify.ts': {
              branches: 100,
            },
          }
        : {
            branches: -1,
            lines: 50,
          },
    },
    include: ['test/**/*.test.ts'],
  },
})
