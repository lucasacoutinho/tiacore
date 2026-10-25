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

// Scripts that run in child processes the runners spawn. They must be real
// files in dist next to the entries (the runners resolve them from there).
const helperEntries = Object.fromEntries(
  [
    'src/runners/node/discovery-register.ts',
    'src/runners/node/discovery-shim.ts',
    'src/runners/node/execution-child.ts',
  ].map((file) => [file.replace(/^.*\//u, '').replace(/\.ts$/u, ''), file]),
)

rmSync('dist', { force: true, recursive: true })
mkdirSync('.build', { recursive: true })

// The local compiler, so a Git-dependency build does not depend on PATH.
const declarations = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' },
)
if (declarations.status !== 0) process.exit(declarations.status ?? 1)

const result = await build({
  bundle: true,
  chunkNames: 'chunks/[name]-[hash]',
  entryNames: '[name]',
  entryPoints: { ...entries, ...helperEntries },
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
