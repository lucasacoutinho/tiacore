import { appendFileSync } from 'node:fs'
import { lazy, Suspense } from 'react'

import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

const LazyPanel = lazy(() => import('../src/LazyPanel.js'))

test('renders a lazy-loaded panel', async () => {
  appendFileSync('executions.log', 'lazy-panel\n')
  render(
    <Suspense fallback={<p>Loading</p>}>
      <LazyPanel />
    </Suspense>,
  )

  expect(screen.getByText('Loading')).toBeTruthy()
  const panel = await screen.findByRole('region', {
    name: 'lazy-panel',
  })
  expect(panel.textContent).toBe('Loaded on demand')
})
