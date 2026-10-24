import { defineConfig } from 'vitest/config'
import { tia } from '@lucasacoutinho/tiacore'
import { CustomThirdPartyReporter } from './custom-reporter'

const reporter = new CustomThirdPartyReporter()

export default defineConfig({
  plugins: [
    tia({
      log: true,
      replayReporters: reporter,
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    reporters: ['default', reporter],
  },
})
