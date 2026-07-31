import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const requiredBuildFiles = [
  'node_modules/@types/istanbul-lib-instrument/index.d.ts',
  'node_modules/@types/node/package.json',
  'node_modules/@types/picomatch/index.d.ts',
  'node_modules/@playwright/test/package.json',
  'node_modules/esbuild/package.json',
  'node_modules/typescript/bin/tsc',
  'node_modules/vite/package.json',
  'node_modules/vitest/package.json',
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

function hasLocalBuildToolchain() {
  return requiredBuildFiles.every((path) =>
    existsSync(join(process.cwd(), path)),
  )
}

function bootstrapGitDependencyBuild() {
  if (hasLocalBuildToolchain()) return false

  const userAgent = process.env.npm_config_user_agent ?? ''
  if (!userAgent.startsWith('bun/')) {
    throw new Error(
      'tiacore prepare is missing its local build toolchain; reinstall from a package tarball or with a package manager that installs Git dependency devDependencies',
    )
  }

  process.stdout.write(
    'tiacore: bootstrapping the pinned development toolchain for a Bun VCS build\n',
  )
  run('npm', ['ci', '--include=dev', '--ignore-scripts'])
  if (!hasLocalBuildToolchain()) {
    throw new Error(
      'tiacore prepare could not provision its local build toolchain',
    )
  }
  return true
}

const bootstrapped = bootstrapGitDependencyBuild()
try {
  run(process.execPath, [
    '-e',
    "require('node:fs').rmSync('dist',{recursive:true,force:true})",
  ])
  run(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '-p',
    'tsconfig.build.json',
  ])
  run(process.execPath, ['config/build-cjs.mjs'])
} finally {
  if (bootstrapped) {
    rmSync(join(process.cwd(), 'node_modules'), {
      force: true,
      recursive: true,
    })
  }
}
