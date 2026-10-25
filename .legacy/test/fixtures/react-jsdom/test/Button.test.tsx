import { appendFileSync } from 'node:fs'

import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Button } from '../src/Button.js'

test('renders a button label', () => {
  appendFileSync('executions.log', 'button\n')
  render(<Button label="Save" />)
  const button = screen.getByRole('button', { name: 'Save' })
  expect(button.className).toBeTruthy()
  expect(button.getAttribute('data-icon')).toBe('true')
})
