import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createGradleGraph,
  discoverGradleSuites,
  gradleCatalogFingerprint,
  parseJUnitReport,
  planGradle,
  readJUnitReports,
  tia,
} from '../../src/runners/gradle/index.ts'
import { assertNoLeak } from '../support/leak.ts'
import { legacy } from '../support/legacy.ts'

const fixture = fileURLToPath(
  new URL('../fixtures/gradle-project', import.meta.url),
)
const fakeGradle = join(fixture, 'fake-gradle.mjs')
const old = await legacy<typeof import('../../src/runners/gradle/index.ts')>(
  'adapters/gradle/index.js',
)
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tiacore-gradle-project-'))
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

const java = (pkg: string, name: string, extra = '') =>
  `package ${pkg};\n${extra}\npublic class ${name} {}\n`

async function graphOf(root: string) {
  const suites = await discoverGradleSuites({ project: 'app', root })
  return createGradleGraph(root, { environmentFingerprint: 'env', suites })
}

describe('Gradle against 1.x', () => {
  test('discovery, fingerprint and graph match byte for byte', async () => {
    const options = { project: 'app', root: fixture }
    const suites = await discoverGradleSuites(options)
    expect(JSON.stringify(suites)).toBe(
      JSON.stringify(await old.discoverGradleSuites(options)),
    )
    expect(gradleCatalogFingerprint(suites)).toBe(
      old.gradleCatalogFingerprint(suites),
    )
    const graph = await createGradleGraph(fixture, {
      environmentFingerprint: 'env',
      suites,
    })
    expect(JSON.stringify(graph)).toBe(
      JSON.stringify(
        await old.createGradleGraph(fixture, {
          environmentFingerprint: 'env',
          suites,
        }),
      ),
    )
  })

  test('JUnit parsing matches on the shapes Gradle writes', () => {
    const documents = [
      '<testsuite><testcase classname="a.A" name="x" time="1.5"/></testsuite>',
      '<testsuites><testsuite><testsuite><testcase classname="a.A" name="y"><skipped/></testcase></testsuite></testsuite></testsuites>',
      '<testsuite><testcase classname="a.A" name="e"><error message="m"/></testcase><testcase name="n"><failure/><skipped/></testcase></testsuite>',
      '<other/>',
      '',
    ]
    for (const xml of documents) {
      expect(parseJUnitReport(xml)).toEqual(old.parseJUnitReport(xml))
    }
  })
})

describe('Gradle discovery', () => {
  test('derives class names, honors replacement globs and skips build output', async () => {
    const root = await project({
      'src/test/java/a/One.java': java('a', 'One'),
      'src/test/kotlin/NoPkg.kt': 'class NoPkg\n',
      'src/test/kotlin/Quirk.kt':
        'package q\n@Test class Hidden\nclass Quirk\n',
      'src/androidTest/java/b/Two.java': java('b', 'Two'),
      'src/test/java/Helper.kts': '',
      'build/src/test/java/Gen.java': java('g', 'Gen'),
    })
    const suites = await discoverGradleSuites({ project: 'app', root })
    expect(suites.map((suite) => [suite.className, suite.file])).toEqual([
      ['b.Two', 'src/androidTest/java/b/Two.java'],
      ['a.One', 'src/test/java/a/One.java'],
      ['NoPkg', 'src/test/kotlin/NoPkg.kt'],
      ['q.Quirk', 'src/test/kotlin/Quirk.kt'],
    ])
    expect(Object.keys(suites[0] ?? {})).toEqual([
      'adapter',
      'className',
      'file',
      'id',
      'project',
    ])
    const replaced = await discoverGradleSuites({
      project: 'app',
      root,
      tests: ['src/test/java/**/*.java'],
    })
    expect(replaced.map((suite) => suite.className)).toEqual(['a.One'])
  })

  test('sources have no effect on discovery or planning', async () => {
    const root = await project({ 'src/test/java/a/One.java': java('a', 'One') })
    const plain = await discoverGradleSuites({ project: 'app', root })
    expect(
      await discoverGradleSuites({
        project: 'app',
        root,
        sources: ['nothing'],
      }),
    ).toEqual(plain)
  })
})

describe('Gradle graph', () => {
  test('wildcard and same-package references create no edge', async () => {
    const root = await project({
      'src/main/java/same/Used.java': java('same', 'Used'),
      'src/main/java/wild/Wild.java': java('wild', 'Wild'),
      'src/main/java/direct/Direct.java': java('direct', 'Direct'),
      'src/test/java/same/SamePkgTest.java': java('same', 'SamePkgTest'),
      'src/test/java/wild/WildTest.java': java(
        'wild',
        'WildTest',
        'import wild.*;',
      ),
      'src/test/java/direct/DirectTest.java': java(
        'direct',
        'DirectTest',
        'import direct.Direct.Inner;',
      ),
    })
    const graph = await graphOf(root)
    const edges = (id: string) =>
      graph.observations
        .filter((observation) => observation.suiteId.endsWith(id))
        .map(({ confidence, kind, source }) => [source, kind, confidence])
    expect(edges('SamePkgTest.java')).toEqual([
      ['src/test/java/same/SamePkgTest.java', 'configuration', 'exact'],
    ])
    expect(edges('WildTest.java')).toEqual([
      ['src/test/java/wild/WildTest.java', 'configuration', 'exact'],
    ])
    expect(edges('DirectTest.java')).toEqual([
      ['src/test/java/direct/DirectTest.java', 'configuration', 'exact'],
      ['src/main/java/direct/Direct.java', 'import', 'inferred'],
    ])
  })

  test('known sources and invalidators decide what forces a full run', async () => {
    const root = await project({
      'src/main/java/a/Lonely.java': java('a', 'Lonely'),
      'src/test/java/a/OneTest.java': java('a', 'OneTest'),
    })
    const graph = await graphOf(root)
    expect(graph.knownSources).toEqual([
      'src/main/java/a/Lonely.java',
      'src/test/java/a/OneTest.java',
    ])
    const plan = (changes: string[], extra = {}) =>
      planGradle({
        changes,
        currentEnvironmentFingerprint: 'env',
        graph,
        project: 'app',
        root,
        ...extra,
      })
    expect((await plan(['src/main/java/a/Lonely.java'])).mode).toBe('skip')
    expect(await plan(['gradle/libs.versions.toml'])).toMatchObject({
      mode: 'full',
      reason:
        'changed file is unknown to the impact graph: gradle/libs.versions.toml',
    })
    expect(
      (await plan(['gradle/libs.versions.toml'], { onUnknownChange: 'ignore' }))
        .mode,
    ).toBe('skip')
    expect(await plan(['app/build.gradle.kts'])).toMatchObject({
      mode: 'full',
      reason: 'Gradle build configuration changed: app/build.gradle.kts',
    })
    expect(await plan(['gradle.properties'])).toMatchObject({
      reason: 'Gradle properties changed: gradle.properties',
    })
    expect(await plan(['settings.gradle'])).toMatchObject({
      reason: 'Gradle build configuration changed: settings.gradle',
    })
  })
})

describe('JUnit reports', () => {
  test('classifies failures, errors and skips', () => {
    expect(
      parseJUnitReport(
        '<testsuite><testcase classname="a.A" name="e"><error/></testcase><testcase classname="a.A" name="s"><skipped/></testcase><testcase classname="a.A" name="b"><failure/><skipped/></testcase><testcase/></testsuite>',
      ).map((item) => [item.name, item.status, item.className]),
    ).toEqual([
      ['e', 'failed', 'a.A'],
      ['s', 'skipped', 'a.A'],
      ['b', 'failed', 'a.A'],
      ['', 'passed', ''],
    ])
  })

  test('empty and non-JUnit documents have no cases and malformed XML throws', () => {
    expect(parseJUnitReport('')).toEqual([])
    expect(parseJUnitReport('<other/>')).toEqual([])
    expect(() => parseJUnitReport('<testsuite><testcase')).toThrow(/./u)
  })

  test('reads every matching file under build/test-results in path order', async () => {
    const root = await project({
      'a/build/test-results/test/x.xml':
        '<testsuite><testcase classname="a.A" name="1"/></testsuite>',
      'b/build/test-results/test/y.xml':
        '<testsuite><testcase classname="b.B" name="2"/></testsuite>',
    })
    expect((await readJUnitReports(root)).map((item) => item.name)).toEqual([
      '1',
      '2',
    ])
  })
})

function runner(root: string, directory: string, extra = {}) {
  return tia({
    changes: [],
    command: process.execPath,
    commandArguments: [fakeGradle],
    currentEnvironmentFingerprint: 'env',
    environment: { TIACORE_GRADLE_LOG: join(directory, 'gradle.log') },
    project: 'app',
    root,
    ...extra,
  })
}

async function copy(): Promise<{ directory: string; root: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'tiacore-gradle-run-'))
  temporary.push(directory)
  const root = join(directory, 'project')
  const { cp } = await import('node:fs/promises')
  await cp(fixture, root, {
    filter: (source) => !source.includes(`${sep}build`),
    recursive: true,
  })
  return { directory, root }
}

describe('Gradle runner', () => {
  test('stores the graph under .tia/gradle of the root by default', async () => {
    const { directory, root } = await copy()
    const result = await runner(root, directory).run()
    expect(result.success).toBe(true)
    expect(existsSync(join(root, '.tia/gradle/graph.json'))).toBe(true)
  })

  test('selects nothing without touching the executable or the graph', async () => {
    const { directory, root } = await copy()
    await runner(root, directory).run()
    const graphPath = join(root, '.tia/gradle/graph.json')
    const before = await readFile(graphPath, 'utf8')
    await rm(join(directory, 'gradle.log'))
    const second = await runner(root, directory, {
      command: join(directory, 'does-not-exist'),
    }).run()
    expect(second).toEqual({
      cases: [],
      plan: expect.objectContaining({ mode: 'skip' }),
      status: 0,
      success: true,
    })
    expect(existsSync(join(directory, 'gradle.log'))).toBe(false)
    expect(await readFile(graphPath, 'utf8')).toBe(before)
  })

  test('requires gradlew in the root when no command is given', async () => {
    const { directory, root } = await copy()
    await expect(
      tia({
        changes: [],
        currentEnvironmentFingerprint: 'env',
        project: 'app',
        root,
      }).run(),
    ).rejects.toThrow(/ENOENT/u)
    expect(existsSync(join(directory, 'gradle.log'))).toBe(false)
  })

  test('puts commandArguments before the task and passes a custom task', async () => {
    const { directory, root } = await copy()
    await runner(root, directory, {
      commandArguments: [fakeGradle, '--quiet'],
      task: 'check',
    }).run()
    expect(await readFile(join(directory, 'gradle.log'), 'utf8')).toContain(
      '--quiet check --tests com.example.CalculatorTest',
    )
  })

  test('requireReports false drops only the missing-report check', async () => {
    const { directory, root } = await copy()
    const relaxed = await runner(root, directory, {
      environment: {
        TIACORE_GRADLE_LOG: join(directory, 'gradle.log'),
        TIACORE_GRADLE_SKIP_REPORTS: '1',
      },
      requireReports: false,
    }).run()
    expect(relaxed).toMatchObject({ cases: [], status: 0, success: true })
    const failing = await runner(root, directory, {
      environment: {
        TIACORE_GRADLE_LOG: join(directory, 'gradle.log'),
        TIACORE_GRADLE_TEST_FAILURE: '1',
      },
      forceFull: true,
      requireReports: false,
    }).run()
    expect(failing).toMatchObject({ status: 1, success: false })
    expect(failing.cases.length).toBeGreaterThan(0)
  })

  test('rejects result files left by an earlier run (GRADLE-RUN-09)', async () => {
    const { directory, root } = await copy()
    const good = await runner(root, directory).run()
    expect(good).toMatchObject({ status: 0, success: true })
    const graphPath = join(root, '.tia/gradle/graph.json')
    await rm(graphPath)
    const stale = await runner(root, directory, {
      environment: {
        TIACORE_GRADLE_LOG: join(directory, 'gradle.log'),
        TIACORE_GRADLE_SKIP_REPORTS: '1',
      },
    }).run()
    expect(stale).toMatchObject({ cases: [], status: 1, success: false })
    expect(existsSync(graphPath)).toBe(false)
  })

  test('accepts result files this run wrote', async () => {
    const { directory, root } = await copy()
    const result = await runner(root, directory).run()
    expect(result.cases.map((item) => item.className).sort()).toEqual([
      'com.example.CalculatorTest',
      'com.example.GreeterTest',
    ])
  })

  test('leaves no marker file behind', async () => {
    const { directory, root } = await copy()
    await runner(root, directory).run()
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(join(root, '.tia/gradle'))).toEqual(['graph.json'])
  })

  test('does not leak across repeated runs', async () => {
    const { directory, root } = await copy()
    const { bytesPerOperation } = await assertNoLeak(
      () => runner(root, directory, { forceFull: true }).run(),
      { bytesPerOperation: 20_000, iterations: 10 },
    )
    expect(bytesPerOperation).toBeLessThan(20_000)
  }, 60_000)
})
