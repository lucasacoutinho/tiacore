import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

// Runs on `npm install` in a checkout and when a package manager installs
// tiacore from a Git URL. A Git install needs dist/, which is not committed,
// so it builds. A checkout only patches the TypeScript language service:
// `npm test` builds before it tests.
//
// The package manager sets INIT_CWD to the directory it was run in; for a
// dependency that is the consumer's project, not this one. Without INIT_CWD,
// build: it is never wrong, only slower.
//
// npm builds a Git dependency in a cache directory with its devDependencies
// installed, so it builds in place. Bun builds it inside the consumer's
// node_modules without them. TypeScript will not write declarations for
// sources inside node_modules (it cannot name `effect` from there), so that
// case copies the sources to a temporary directory, installs the pinned
// toolchain there, builds, and copies dist/ back.

const root = process.cwd()
const initCwd = process.env.INIT_CWD
const dependencyInstall =
  initCwd === undefined || resolve(initCwd) !== resolve(root)

const requiredBuildFiles = [
  'node_modules/@effect/platform-node/package.json',
  'node_modules/@types/node/package.json',
  'node_modules/effect/package.json',
  'node_modules/esbuild/package.json',
  'node_modules/typescript/bin/tsc',
]

function run(command, arguments_, cwd = root) {
  const result = spawnSync(command, arguments_, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(' ')} exited with ${result.status ?? 'no status'}`,
    )
  }
}

const hasBuildToolchain = (directory) =>
  requiredBuildFiles.every((path) => existsSync(join(directory, path)))

const insideNodeModules = (directory) =>
  realpathSync(directory).split(sep).includes('node_modules')

function buildIsolated() {
  process.stdout.write(
    'tiacore: building in a temporary directory with the pinned toolchain\n',
  )
  const workspace = mkdtempSync(join(tmpdir(), 'tiacore-build-'))
  try {
    cpSync(root, workspace, {
      filter: (source) => {
        const top = source.slice(root.length + 1).split(sep)[0]
        return top !== 'node_modules' && top !== '.git'
      },
      recursive: true,
    })
    run('npm', ['ci', '--include=dev', '--ignore-scripts'], workspace)
    run(process.execPath, ['build.mjs'], workspace)
    rmSync(join(root, 'dist'), { force: true, recursive: true })
    cpSync(join(workspace, 'dist'), join(root, 'dist'), { recursive: true })
  } finally {
    rmSync(workspace, { force: true, recursive: true })
  }
}

if (!dependencyInstall) {
  // The Effect language service patch serves development type checks only.
  if (existsSync('node_modules/@effect/tsgo/package.json')) {
    run(process.execPath, [
      'node_modules/@effect/tsgo/dist/effect-tsgo.cjs',
      'patch',
      '--typescript',
      '--no-oxlint',
    ])
  }
} else if (hasBuildToolchain(root) && !insideNodeModules(root)) {
  run(process.execPath, ['build.mjs'])
} else {
  buildIsolated()
}
