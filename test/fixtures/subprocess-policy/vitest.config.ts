import { defineConfig } from 'vitest/config'
import { tia } from '@lucasacoutinho/tiacore'

export default defineConfig({
  plugins: [
    tia({
      coverage: {
        include: ['src/**/*.{mjs,ts}'],
        reporters: ['json'],
      },
      frameworks:
        process.env.TIA_SUBPROCESS_MAP === '1'
          ? {
              subprocess: {
                mappings: [
                  {
                    files: ['src/child.mjs'],
                    tests: ['test/child.test.ts'],
                  },
                ],
              },
            }
          : undefined,
      log: true,
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
})
