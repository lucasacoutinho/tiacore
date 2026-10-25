import { appendFileSync } from 'node:fs'

import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Badge } from '../src/Badge.js'

test('renders a status badge', () => {
  appendFileSync('executions.log', 'badge\n')
  render(<Badge text="Ready" />)
  const badge = screen.getByLabelText('status')
  expect(badge.textContent).toBe('Ready')
  expect(badge.getAttribute('data-copy')).toBe('ready-copy')
})
