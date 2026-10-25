import { appendFileSync } from 'node:fs'

import { expect, test } from './fixture'

test('loads a dynamic browser module', async ({ page }) => {
  appendFileSync('executions.log', 'lazy\n')
  await page.goto('/')
  await page.locator('#load').click()
  await expect(page.locator('#lazy')).toHaveText('lazy ready')
  expect(process.env.TIACORE_PLAYWRIGHT_FAIL).not.toBe('1')
})
