import { chmod, writeFile } from 'node:fs/promises'

import { build } from 'esbuild'

const entryNames = [
  'index',
  'core',
  'protocol',
  'conformance',
  'maestro',
  'k6',
  'bun',
  'node',
  'playwright',
  'vitest',
  'workspace',
]

await build({
  banner: {
    js: [
      "const { pathToFileURL: __tiaPathToFileURL } = require('node:url');",
      'const __tiaImportMetaUrl = __tiaPathToFileURL(__filename).href;',
    ].join('\n'),
  },
  bundle: true,
  define: {
    'import.meta.url': '__tiaImportMetaUrl',
  },
  entryPoints: entryNames.map((name) => `src/${name}.ts`),
  format: 'cjs',
  logLevel: 'warning',
  outdir: 'dist',
  outExtension: {
    '.js': '.cjs',
  },
  packages: 'external',
  platform: 'node',
  sourcemap: true,
  target: 'node20',
})

await build({
  banner: {
    js: [
      "const { pathToFileURL: __tiaPathToFileURL } = require('node:url');",
      'const __tiaImportMetaUrl = __tiaPathToFileURL(__filename).href;',
    ].join('\n'),
  },
  bundle: true,
  define: {
    'import.meta.url': '__tiaImportMetaUrl',
  },
  entryPoints: {
    'playwright-reporter': 'src/adapters/playwright/reporter.ts',
  },
  format: 'cjs',
  logLevel: 'warning',
  outdir: 'dist',
  outExtension: {
    '.js': '.cjs',
  },
  packages: 'external',
  platform: 'node',
  sourcemap: true,
  target: 'node20',
})

await Promise.all(
  [...entryNames, 'playwright-reporter'].map((name) =>
    writeFile(
      `dist/${name}.d.cts`,
      [
        `declare const moduleExports: typeof import('./${
          name === 'playwright-reporter'
            ? 'adapters/playwright/reporter'
            : name
        }.js', {`,
        `  with: { 'resolution-mode': 'import' },`,
        '})',
        'export = moduleExports',
        '',
      ].join('\n'),
    ),
  ),
)

await chmod('dist/cli.js', 0o755)
