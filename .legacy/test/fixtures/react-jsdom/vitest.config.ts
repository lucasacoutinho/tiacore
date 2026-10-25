import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { tia } from '@lucasacoutinho/tiacore'

export default defineConfig({
  plugins: [react(), tia({ log: true })],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.tsx'],
  },
})
