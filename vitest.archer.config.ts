import { archer } from '@lucasacoutinho/archer/vitest'
import { defineConfig, mergeConfig } from 'vitest/config'

import vitestConfig from './vitest.config.ts'

export default mergeConfig(
  vitestConfig,
  defineConfig({ plugins: [archer({ reporter: 'agent' })] }),
)
