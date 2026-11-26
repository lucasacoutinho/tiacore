import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { readSnapshot } from '../../src/assurance/verify/snapshot-read.ts'
import { tia } from '../../src/runners/gradle/index.ts'

const temporary: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `tiacore-gradle-${prefix}-`))
  temporary.push(directory)
  return directory
}

/**
 * A Gradle stand-in that writes one JUnit case for each class named in
 * REPORTED_CLASSES, the way Gradle reports JUnit 5 @Nested classes.
 */
const reportingGradle = `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = join(process.cwd(), 'build/test-results/test')
mkdirSync(directory, { recursive: true })
const cases = process.env.REPORTED_CLASSES.split(',').map((name) =>
  process.env.CASE_FAILS === '1'
    ? \`<testcase classname="\${name}" name="t"><failure/></testcase>\`
    : \`<testcase classname="\${name}" name="t"/>\`,
)
writeFileSync(join(directory, 'TEST-nested.xml'), \`<testsuite>\${cases.join('')}</testsuite>\`)
`

async function project(testClass: string): Promise<string> {
  const root = await scratch('nested')
  const files = {
    'reporting-gradle.mjs': reportingGradle,
    'src/test/java/a/OuterTest.java': testClass,
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

const outer =
  'package a;\n\nclass OuterTest {\n  @Nested\n  class Inner {}\n}\n'

function runner(root: string, environment: Record<string, string>) {
  return tia({
    changes: [],
    command: process.execPath,
    commandArguments: [join(root, 'reporting-gradle.mjs')],
    currentEnvironmentFingerprint: 'env',
    environment,
    project: 'app',
    root,
  })
}

async function outcomeOf(directory: string): Promise<unknown> {
  const names = await readdir(join(directory, 'full'))
  expect(names).toHaveLength(1)
  const snapshot = readSnapshot(
    JSON.parse(await readFile(join(directory, 'full', names[0] ?? ''), 'utf8')),
    'full',
  )
  if (snapshot === null || snapshot.kind !== 'protocol') {
    throw new Error('expected a protocol snapshot')
  }
  return snapshot.suiteOutcomes[
    'gradle-junit:app:src/test/java/a/OuterTest.java'
  ]
}

describe('Gradle reports of nested test classes', () => {
  test('cases of a class nested in the selected class count as its reports', async () => {
    const root = await project(outer)
    const result = await runner(root, {
      REPORTED_CLASSES: 'a.OuterTest$Inner',
    }).run()
    expect(result).toMatchObject({ status: 0, success: true })
    expect(result.cases.map((item) => item.className)).toEqual([
      'a.OuterTest$Inner',
    ])
  })

  test('a class that only shares a prefix with the selected class does not', async () => {
    const root = await project(outer)
    const result = await runner(root, {
      REPORTED_CLASSES: 'a.OuterTestHelper',
    }).run()
    expect(result).toMatchObject({ status: 1, success: false })
  })

  test('a verification sees how the nested cases ended', async () => {
    const passing = await project(outer)
    const directory = await scratch('nested-target')
    vi.stubEnv('TIA_VERIFICATION_DIRECTORY', directory)
    vi.stubEnv('TIA_VERIFICATION_PHASE', 'full')
    await runner(passing, {
      REPORTED_CLASSES: 'a.OuterTest$Inner$Deeper',
    }).run()
    expect(await outcomeOf(directory)).toBe('passed')

    const failing = await project(outer)
    const other = await scratch('nested-target')
    vi.stubEnv('TIA_VERIFICATION_DIRECTORY', other)
    const result = await runner(failing, {
      CASE_FAILS: '1',
      REPORTED_CLASSES: 'a.OuterTest$Inner',
    }).run()
    expect(result).toMatchObject({ status: 1, success: false })
    expect(await outcomeOf(other)).toBe('failed')
  })
})
