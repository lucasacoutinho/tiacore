import { test as base } from '@playwright/test'
import { tia } from 'tiajs/playwright'

export const test = tia(base)
export { expect } from '@playwright/test'
