declare const moduleExports: typeof import('./playwright/reporter.js', {
  with: { 'resolution-mode': 'import' },
})
export = moduleExports
