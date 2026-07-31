import { chmod, writeFile } from 'node:fs/promises'

import { build } from 'esbuild'

const subpathEntryNames = [
  'adapter',
  'artifacts',
  'core',
  'evidence',
  'protocol',
  'conformance',
  'gradle',
  'maestro',
  'k6',
  'bun',
  'node',
  'playwright',
  'vitest',
  'workspace',
  'verification',
]
const packageEntries = [
  { output: 'index', source: 'src/index.ts' },
  ...subpathEntryNames.map((name) => ({
    output: `entries/${name}`,
    source: `src/entries/${name}.ts`,
  })),
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
  entryPoints: Object.fromEntries(
    packageEntries.map(({ output, source }) => [output, source]),
  ),
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
  [
    ...packageEntries.map(({ output }) => ({
      declarationTarget: `./${output.split('/').at(-1)}.js`,
      output,
    })),
    {
      declarationTarget: './adapters/playwright/reporter.js',
      output: 'playwright-reporter',
    },
  ].map(({ declarationTarget, output }) =>
    writeFile(
      `dist/${output}.d.cts`,
      [
        `declare const moduleExports: typeof import('${declarationTarget}', {`,
        `  with: { 'resolution-mode': 'import' },`,
        '})',
        'export = moduleExports',
        '',
      ].join('\n'),
    ),
  ),
)

await chmod('dist/entries/cli.js', 0o755)
