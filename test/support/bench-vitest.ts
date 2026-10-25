import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Generated Vitest projects for the end-to-end benchmarks: the same test files
// run with plain Vitest, with the 2.0 plugin and with the 1.x plugin.

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const vitestBin = join(packageRoot, 'node_modules/vitest/vitest.mjs')

/** Which plugin the project's Vitest config loads, if any. */
export type Tool = 'current' | 'legacy' | 'plain'

/**
 * The plugin each config imports, by package name as users write it. Vite
 * bundles a config's relative and absolute imports on every run but leaves
 * packages external, so a path import would charge the bundling to the tool.
 */
const plugins: Record<Exclude<Tool, 'plain'>, string> = {
  current: '@lucasacoutinho/tiacore/vitest',
  legacy: 'tiacore-v1/vitest',
}

export interface ProjectShape {
  /** `effect` writes `it.effect` tests that fork fibers. */
  readonly kind: 'effect' | 'plain'
  /** Source modules the test files share. */
  readonly modules: number
  readonly testFiles: number
  readonly testsPerFile: number
}

export const PLAIN_PROJECT: ProjectShape = {
  kind: 'plain',
  modules: 40,
  testFiles: 50,
  testsPerFile: 5,
}

/** Fibers each Effect test forks and joins, and one more it leaves running. */
const FIBERS = 16

export const testsIn = (shape: ProjectShape): number =>
  shape.testFiles * shape.testsPerFile

const FUNCTIONS = 8

/** A source module of `FUNCTIONS` small functions with branches. */
function sourceModule(index: number): string {
  return Array.from(
    { length: FUNCTIONS },
    (_, fn) => `export function f${fn}(value: number): number {
  if (value > ${fn + (index % 5)}) {
    return value % 2 === 0 ? value + ${fn} : value - ${fn}
  }
  const scaled = [value, ${index}, ${fn}].map((item) => item * 2)
  return scaled.reduce((total, item) => total + item, 0)
}
`,
  ).join('\n')
}

/**
 * A test file imports three modules and each of its tests exercises two of
 * them, so tests of one file depend on different sources.
 */
function testFile(shape: ProjectShape, file: number): string {
  const modules = [0, 1, 2].map((offset) => (file * 3 + offset) % shape.modules)
  const imports = modules
    .map((module, slot) => `import * as m${slot} from '../src/m${module}.ts'`)
    .join('\n')
  const tests = Array.from({ length: shape.testsPerFile }, (_, test) => {
    const [first, second] = [test % 3, (test + 1) % 3] as const
    const call = (slot: number, fn: number) =>
      `m${slot}.f${(test + fn) % FUNCTIONS}(${test + 1})`
    if (shape.kind === 'plain') {
      return `test('case ${test}', () => {
  expect(${call(first, 0)} + ${call(second, 1)}).toBeTypeOf('number')
})`
    }
    return `it.effect('case ${test}', () =>
  Effect.gen(function* () {
    yield* Effect.forkDetach(Effect.sleep(1))
    const fibers = yield* Effect.forEach(
      Array.from({ length: ${FIBERS} }, (_, n) => n),
      (n) =>
        Effect.forkChild(
          Effect.gen(function* () {
            yield* Effect.yieldNow
            const a = ${call(first, 0)}
            yield* Effect.yieldNow
            return a + ${call(second, 1)} + n
          }),
        ),
    )
    const results = yield* Effect.forEach(fibers, Fiber.join)
    expect(results).toHaveLength(${FIBERS})
  }),
)`
  }).join('\n\n')
  return shape.kind === 'plain'
    ? `import { expect, test } from 'vitest'\n${imports}\n\n${tests}\n`
    : `import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { expect } from 'vitest'
${imports}

${tests}
`
}

function config(tool: Tool): string {
  const plugin =
    tool === 'plain'
      ? ''
      : `import { tia } from ${JSON.stringify(plugins[tool])}\n`
  return `import { defineConfig } from 'vitest/config'
${plugin}
export default defineConfig({
  cacheDir: '.vite',
  plugins: [${tool === 'plain' ? '' : 'tia({ log: false })'}],
  test: { include: ['test/**/*.test.ts'] },
})
`
}

function vcs(directory: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=tiacore',
      '-c',
      'user.email=bench@tiacore.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: directory, stdio: 'ignore' },
  )
}

function write(root: string, path: string, contents: string): void {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

/** A Vitest project that has not run yet: files, config and one commit. */
export interface VitestTemplate {
  readonly base: string
  readonly shape: ProjectShape
  readonly template: string
  readonly tool: Tool
}

export function buildVitestTemplate(
  shape: ProjectShape,
  tool: Tool,
): VitestTemplate {
  const base = mkdtempSync(join(tmpdir(), 'tiacore-bench-vitest-'))
  const template = join(base, 'template')
  write(template, '.gitignore', 'node_modules\n.tia/\n.vite/\n')
  write(template, 'package.json', '{"private":true,"type":"module"}\n')
  write(template, 'vitest.config.ts', config(tool))
  for (let module = 0; module < shape.modules; module += 1) {
    write(template, `src/m${module}.ts`, sourceModule(module))
  }
  for (let file = 0; file < shape.testFiles; file += 1) {
    write(template, `test/t${file}.test.ts`, testFile(shape, file))
  }
  vcs(template, 'init', '-q')
  vcs(template, 'add', '.')
  vcs(template, 'commit', '-q', '-m', 'baseline')
  return { base, shape, template, tool }
}

export function dropVitestTemplate(project: VitestTemplate): void {
  rmSync(project.base, { force: true, recursive: true })
}

let counter = 0

/** A private copy of `source` (a template or an earlier run) to run in. */
export function copyProject(
  project: VitestTemplate,
  source: string = project.template,
): string {
  counter += 1
  const root = join(project.base, `run-${counter}`)
  cpSync(source, root, { recursive: true, verbatimSymlinks: true })
  return root
}

export interface VitestRun {
  readonly failed: number
  readonly ms: number
  readonly passed: number
  readonly skipped: number
  readonly total: number
}

function countOf(line: string, label: string): number {
  return Number(new RegExp(`(\\d+) ${label}`, 'u').exec(line)?.[1] ?? 0)
}

/**
 * One `vitest run` in `root`, timed from outside as a user waits for it. The
 * counts come from the final `Tests` line, so a run that did not do what the
 * workload assumes is caught by the caller.
 */
export function runVitest(root: string): VitestRun {
  // The repository's node_modules, linked so the project resolves vitest,
  // vite, effect and the plugins' dependencies.
  if (!existsSync(join(root, 'node_modules'))) linkModules(root)
  const started = performance.now()
  const result = spawnSync(process.execPath, [vitestBin, 'run'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 256 * 1024 * 1024,
  })
  const ms = performance.now() - started
  const output = `${result.stdout}${result.stderr}`
  if (result.status !== 0) {
    throw new Error(`vitest run failed in ${root}\n${output}`)
  }
  const line = output.split('\n').find((text) => /^\s*Tests\s/u.test(text))
  if (line === undefined) {
    throw new Error(`vitest printed no summary in ${root}\n${output}`)
  }
  return {
    failed: countOf(line, 'failed'),
    ms,
    passed: countOf(line, 'passed'),
    skipped: countOf(line, 'skipped'),
    total: Number(/\((\d+)\)/u.exec(line)?.[1] ?? 0),
  }
}

/** Changes a source module so that the tests that import it are affected. */
export function editModule(root: string, module: number): void {
  write(
    root,
    `src/m${module}.ts`,
    `${sourceModule(module)}\nexport const edited = true\n`,
  )
}

/**
 * A node_modules of links: every package the repository has, plus this
 * checkout as `@lucasacoutinho/tiacore`, so the config imports 2.0 by name.
 */
function linkModules(root: string): void {
  const source = join(packageRoot, 'node_modules')
  const target = join(root, 'node_modules')
  mkdirSync(target)
  for (const entry of readdirSync(source)) {
    if (entry !== '@lucasacoutinho') {
      symlinkSync(join(source, entry), join(target, entry))
      continue
    }
    mkdirSync(join(target, entry))
    for (const scoped of readdirSync(join(source, entry))) {
      symlinkSync(join(source, entry, scoped), join(target, entry, scoped))
    }
  }
  symlinkSync(packageRoot, join(target, '@lucasacoutinho', 'tiacore'))
}
