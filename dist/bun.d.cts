declare const moduleExports: typeof import('./bun.js', {
  with: { 'resolution-mode': 'import' },
})
export = moduleExports
