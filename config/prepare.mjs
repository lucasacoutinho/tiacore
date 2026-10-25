import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Runs on `npm install` in a checkout and when a package manager installs
// tiacore from a Git URL. A Git install needs dist/, which is not committed,
// so it builds. A checkout only patches the TypeScript language service:
// `npm test` builds before it tests. The package manager sets INIT_CWD to the
// directory it was run in; for a dependency that is the consumer's project,
// not this one. Without INIT_CWD, build: it is never wrong, only slower.
// Bun does not install a Git dependency's devDependencies, so a Bun install
// provisions them for the build and removes them afterwards.

const initCwd = process.env.INIT_CWD
const dependencyInstall =
  initCwd === undefined || resolve(initCwd) !== resolve(process.cwd())

const requiredBuildFiles = [
  'node_modules/@effect/platform-node/package.json',
  'node_modules/@types/node/package.json',
  'node_modules/effect/package.json',
  'node_modules/esbuild/package.json',
  'node_modules/typescript/bin/tsc',
]

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(' ')} exited with ${result.status ?? 'no status'}`,
    )
  }
}

function hasBuildToolchain() {
  return requiredBuildFiles.every((path) =>
    existsSync(join(process.cwd(), path)),
  )
}

function provisionToolchain() {
  if (hasBuildToolchain()) return false
  const userAgent = process.env.npm_config_user_agent ?? ''
  if (!userAgent.startsWith('bun/')) {
    throw new Error(
      'tiacore prepare is missing its build toolchain; install from a package tarball or with a package manager that installs Git dependency devDependencies',
    )
  }
  process.stdout.write(
    'tiacore: installing the pinned build toolchain for a Bun Git install\n',
  )
  run('npm', ['ci', '--include=dev', '--ignore-scripts'])
  if (!hasBuildToolchain()) {
    throw new Error('tiacore prepare could not install its build toolchain')
  }
  return true
}

const provisioned = dependencyInstall && provisionToolchain()
try {
  // The Effect language service patch serves development type checks only.
  if (existsSync('node_modules/@effect/tsgo/package.json')) {
    run(process.execPath, [
      'node_modules/@effect/tsgo/dist/effect-tsgo.cjs',
      'patch',
      '--typescript',
      '--no-oxlint',
    ])
  }
  if (dependencyInstall) run(process.execPath, ['config/build.mjs'])
} finally {
  if (provisioned) {
    rmSync(join(process.cwd(), 'node_modules'), {
      force: true,
      recursive: true,
    })
  }
}
