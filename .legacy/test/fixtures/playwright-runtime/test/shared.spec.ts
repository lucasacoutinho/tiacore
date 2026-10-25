import { appendFileSync } from 'node:fs'

import { expect, test } from './fixture'

test('renders the shared application shell', async ({ page }) => {
  appendFileSync('executions.log', 'shared\n')
  await page.goto('/')
  await expect(page.locator('#shared')).toHaveText('shared ready')
})
