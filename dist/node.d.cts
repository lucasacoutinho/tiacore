declare const moduleExports: typeof import('./node.js', {
  with: { 'resolution-mode': 'import' },
})
export = moduleExports
