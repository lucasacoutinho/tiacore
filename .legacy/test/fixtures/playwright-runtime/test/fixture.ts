import { test as base } from '@playwright/test'
import { tia } from '@lucasacoutinho/tiacore/playwright'

export const test = tia(base)
export { expect } from '@playwright/test'
