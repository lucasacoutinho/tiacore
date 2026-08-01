import { defineConfig, mergeConfig } from 'vitest/config'

import { loadArcherPlugin } from './config/load-archer.mjs'
import vitestConfig from './vitest.config.js'

const { archer } = loadArcherPlugin()

export default mergeConfig(
  vitestConfig,
  defineConfig({
    plugins: [archer({ reporter: 'agent' })],
  }),
)
