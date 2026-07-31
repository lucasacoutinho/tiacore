import { defineConfig } from 'vitest/config'
import { tia } from '@usescherie/tiacore'

export default defineConfig({
  plugins: [
    tia({
      ...(process.env.TIA_FILESYSTEM_ARTIFACTS === '1'
        ? {
            artifacts: {
              provider: 'filesystem',
              paths: ['.tia-artifacts'],
            } as const,
            artifactTrust: { allowUnsigned: true },
          }
        : {}),
      cacheDir: process.env.TIA_CACHE_DIR ?? '.tia',
      log: true,
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
})
