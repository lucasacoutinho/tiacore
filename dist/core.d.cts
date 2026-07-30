declare const moduleExports: typeof import('./core.js', {
  with: { 'resolution-mode': 'import' },
})
export = moduleExports
