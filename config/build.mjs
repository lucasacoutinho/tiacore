import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'

import { build } from 'esbuild'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const entries = {
  ...Object.fromEntries(
    readdirSync('src/entries')
      .filter((file) => file.endsWith('.ts'))
      .map((file) => [file.replace(/\.ts$/u, ''), join('src/entries', file)]),
  ),
  // Loaded by Vitest workers through setupFiles, so it is its own file.
  'vitest-setup': 'src/runners/vitest/setup.ts',
}

rmSync('dist', { force: true, recursive: true })
mkdirSync('.build', { recursive: true })

const declarations = spawnSync('tsc', ['-p', 'tsconfig.build.json'], {
  shell: process.platform === 'win32',
  stdio: 'inherit',
})
if (declarations.status !== 0) process.exit(declarations.status ?? 1)

const result = await build({
  bundle: true,
  chunkNames: 'chunks/[name]-[hash]',
  entryNames: '[name]',
  entryPoints: entries,
  external: [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...builtinModules,
    'node:*',
  ],
  format: 'esm',
  legalComments: 'external',
  metafile: true,
  minify: true,
  outdir: 'dist/entries',
  platform: 'node',
  sourcemap: 'linked',
  splitting: true,
  target: 'node22.12',
})
writeFileSync('.build/meta.json', JSON.stringify(result.metafile))

const cli = 'dist/entries/cli.js'
writeFileSync(cli, `#!/usr/bin/env node\n${readFileSync(cli, 'utf8')}`)
chmodSync(cli, 0o755)
