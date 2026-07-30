import { defineConfig } from '@playwright/test'
import { tia } from 'tiajs/playwright'

export default defineConfig({
  testDir: './test',
  reporter: [['line'], tia()],
  use: {
    baseURL: process.env.BASE_URL,
  },
  workers: 2,
})
