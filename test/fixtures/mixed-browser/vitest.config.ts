import { appendFileSync, existsSync } from 'node:fs'

import { playwright } from '@vitest/browser-playwright'
import { chromium } from 'playwright'
import { defineConfig } from 'vitest/config'
import { tia } from '@lucasacoutinho/tiacore'

const executablePath =
  process.env.TIA_CHROME_PATH ??
  (existsSync(chromium.executablePath())
    ? chromium.executablePath()
    : existsSync('/usr/bin/google-chrome')
      ? '/usr/bin/google-chrome'
      : undefined)

export default defineConfig({
  plugins: [tia({ log: true })],
  test: {
    include: [],
    projects: [
      {
        extends: true,
        test: {
          name: 'node-project',
          include: ['test/node.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser-project',
          include: ['test/browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions:
                executablePath === undefined ? {} : { executablePath },
            }),
            instances: [{ browser: 'chromium' }],
            commands: {
              markExecution(_context, name: string) {
                appendFileSync('executions.log', `${name}\n`)
              },
            },
          },
        },
      },
    ],
  },
})
