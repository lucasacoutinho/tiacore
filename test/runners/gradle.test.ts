import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createGradleGraph,
  discoverGradleSuites,
  parseJUnitReport,
  planGradle,
  tia,
} from '../../src/runners/gradle/index.ts'

const root = fileURLToPath(
  new URL('../fixtures/gradle-project', import.meta.url),
)
const fakeGradle = join(root, 'fake-gradle.mjs')
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
  await rm(join(root, 'build'), { recursive: true, force: true })
})

async function failingRun(injected: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'tiacore-gradle-failure-'))
  temporary.push(directory)
  const graphPath = join(directory, 'graph.json')
  const result = await tia({
    changes: [],
    command: process.execPath,
    commandArguments: [fakeGradle],
    currentEnvironmentFingerprint: 'jdk17-gradle9',
    environment: {
      TIACORE_GRADLE_LOG: join(directory, 'gradle.log'),
      ...injected,
    },
    graphPath,
    project: 'app',
    root,
  }).run()
  return { graphPath, result }
}

describe('Gradle/JUnit adapter', () => {
  test('discovers Java and Kotlin classes and selects imported production code', async () => {
    const suites = await discoverGradleSuites({ project: 'app', root })
    expect(suites.map((suite) => suite.className)).toEqual([
      'com.example.CalculatorTest',
      'com.example.GreeterTest',
    ])
    const graph = await createGradleGraph(root, {
      environmentFingerprint: 'jdk17-gradle9',
      suites,
    })
    const plan = await planGradle({
      changes: ['src/main/java/com/example/Calculator.java'],
      currentEnvironmentFingerprint: 'jdk17-gradle9',
      graph,
      project: 'app',
      root,
    })
    expect(plan.mode).toBe('selective')
    expect(plan.selected).toEqual([
      'gradle-junit:app:src/test/java/com/example/CalculatorTest.java',
    ])

    const transitive = await planGradle({
      changes: ['src/main/java/com/example/MathSupport.java'],
      currentEnvironmentFingerprint: 'jdk17-gradle9',
      graph,
      project: 'app',
      root,
    })
    expect(transitive.selected).toEqual([
      'gradle-junit:app:src/test/java/com/example/CalculatorTest.java',
    ])
  })

  test('parses nested JUnit reports without a bespoke XML parser', () => {
    expect(
      parseJUnitReport(
        '<testsuites><testsuite><testcase classname="a.A" name="ok" time="0.2"/><testcase classname="b.B" name="no"><failure/></testcase></testsuite></testsuites>',
      ),
    ).toEqual([
      { className: 'a.A', durationSeconds: 0.2, name: 'ok', status: 'passed' },
      { className: 'b.B', name: 'no', status: 'failed' },
    ])
  })

  test('executes selected classes in one native Gradle invocation and validates reports', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tiacore-gradle-'))
    temporary.push(directory)
    const graphPath = join(directory, 'graph.json')
    const log = join(directory, 'gradle.log')
    const result = await tia({
      changes: [],
      command: process.execPath,
      commandArguments: [fakeGradle],
      currentEnvironmentFingerprint: 'jdk17-gradle9',
      environment: { TIACORE_GRADLE_LOG: log },
      graphPath,
      project: 'app',
      root,
    }).run()
    expect(result.success).toBe(true)
    expect(result.cases).toHaveLength(2)
    expect(readFileSync(log, 'utf8')).toContain(
      'test --tests com.example.CalculatorTest --tests com.example.GreeterTest',
    )
    expect(JSON.parse(readFileSync(graphPath, 'utf8'))).toMatchObject({
      complete: true,
      protocolVersion: 1,
    })
  })

  test('does not promote after a failed Gradle process', async () => {
    const { graphPath, result } = await failingRun({
      TIACORE_GRADLE_PROCESS_FAILURE: '1',
    })
    expect(result).toMatchObject({ status: 7, success: false })
    expect(existsSync(graphPath)).toBe(false)
  })

  test('does not promote after missing JUnit reports', async () => {
    const { graphPath, result } = await failingRun({
      TIACORE_GRADLE_SKIP_REPORTS: '1',
    })
    expect(result).toMatchObject({ status: 1, success: false })
    expect(existsSync(graphPath)).toBe(false)
  })

  test('does not promote after a failed JUnit case', async () => {
    const { graphPath, result } = await failingRun({
      TIACORE_GRADLE_TEST_FAILURE: '1',
    })
    expect(result).toMatchObject({ status: 1, success: false })
    expect(existsSync(graphPath)).toBe(false)
  })
})
