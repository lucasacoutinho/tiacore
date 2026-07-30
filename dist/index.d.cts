declare const moduleExports: typeof import('./index.js', {
  with: { 'resolution-mode': 'import' },
})
export = moduleExports
