declare const moduleExports: typeof import('./playwright.js', {
  with: { 'resolution-mode': 'import' },
})
export = moduleExports
