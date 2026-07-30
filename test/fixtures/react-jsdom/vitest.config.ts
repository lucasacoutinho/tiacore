import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { tia } from 'tiajs'

export default defineConfig({
  plugins: [react(), tia({ log: true })],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.tsx'],
  },
})
