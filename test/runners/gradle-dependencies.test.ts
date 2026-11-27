import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { TiaImpactGraph } from '../../src/core/protocol.ts'
import {
  createGradleGraph,
  discoverGradleSuites,
  planGradle,
} from '../../src/runners/gradle/index.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tiacore-gradle-dependencies-'))
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

async function graphOf(root: string): Promise<TiaImpactGraph> {
  const suites = await discoverGradleSuites({ project: 'app', root })
  return createGradleGraph(root, { environmentFingerprint: 'env', suites })
}

/** The files the graph says the test class in `testFile` imports. */
function importsOf(graph: TiaImpactGraph, testFile: string): string[] {
  return graph.observations
    .filter(
      (observation) =>
        observation.suiteId === `gradle-junit:app:${testFile}` &&
        observation.kind === 'import',
    )
    .map((observation) => observation.source)
}

async function selected(
  root: string,
  graph: TiaImpactGraph,
  changes: string[],
): Promise<string[]> {
  const plan = await planGradle({
    changes,
    currentEnvironmentFingerprint: 'env',
    graph,
    project: 'app',
    root,
  })
  return plan.selected
}

describe('Gradle dependencies without an import', () => {
  test('same-package classes a test names are dependencies, transitively', async () => {
    const root = await project({
      'src/main/java/shop/Cart.java':
        'package shop;\n\npublic class Cart {\n  Price total() { return new Price(); }\n}\n',
      'src/main/java/shop/Price.java':
        'package shop;\n\npublic class Price {}\n',
      'src/main/java/shop/Unused.java':
        'package shop;\n\npublic class Unused {}\n',
      'src/test/java/shop/CartTest.java':
        'package shop;\n\nclass CartTest {\n  Cart cart = new Cart();\n}\n',
    })
    const graph = await graphOf(root)
    expect(importsOf(graph, 'src/test/java/shop/CartTest.java')).toEqual([
      'src/main/java/shop/Cart.java',
      'src/main/java/shop/Price.java',
    ])
    expect(
      await selected(root, graph, ['src/main/java/shop/Price.java']),
    ).toEqual(['gradle-junit:app:src/test/java/shop/CartTest.java'])
    expect(
      await selected(root, graph, ['src/main/java/shop/Unused.java']),
    ).toEqual([])
  })

  test('Kotlin top-level functions are dependencies in the same package and through an import', async () => {
    const root = await project({
      'src/main/kotlin/shop/Strings.kt':
        'package shop\n\nfun String.shout(): String = uppercase()\n',
      'src/main/kotlin/shop/Money.kt': 'package shop\n\nval zero = 0\n',
      'src/main/kotlin/text/Case.kt':
        'package text\n\nfun snake(value: String): String = value\n',
      'src/test/kotlin/shop/ShoutTest.kt':
        'package shop\n\nclass ShoutTest {\n  val loud = "a".shout()\n}\n',
      'src/test/kotlin/app/CaseTest.kt':
        'package app\n\nimport text.snake\n\nclass CaseTest {\n  val name = snake("A")\n}\n',
    })
    const graph = await graphOf(root)
    expect(importsOf(graph, 'src/test/kotlin/shop/ShoutTest.kt')).toEqual([
      'src/main/kotlin/shop/Strings.kt',
    ])
    expect(importsOf(graph, 'src/test/kotlin/app/CaseTest.kt')).toEqual([
      'src/main/kotlin/text/Case.kt',
    ])
  })
  test('Kotlin operator functions reach every file of their package, since operators are used without their name', async () => {
    const root = await project({
      'src/main/kotlin/money/Money.kt':
        'package money\n\ndata class Money(val cents: Long)\n',
      'src/main/kotlin/money/MoneyMath.kt':
        'package money\n\noperator fun Money.plus(other: Money) = Money(cents + other.cents)\n',
      'src/main/kotlin/money/Unrelated.kt':
        'package money\n\nprivate operator fun Money.minus(other: Money) = Money(cents - other.cents)\n',
      'src/test/kotlin/money/MoneyTest.kt':
        'package money\n\nclass MoneyTest {\n  val sum = Money(1) + Money(2)\n}\n',
      'src/test/kotlin/app/WalletTest.kt':
        'package app\n\nimport money.*\n\nclass WalletTest {\n  val sum = Money(1) + Money(2)\n}\n',
    })
    const graph = await graphOf(root)
    const money = [
      'src/main/kotlin/money/Money.kt',
      'src/main/kotlin/money/MoneyMath.kt',
    ]
    expect(importsOf(graph, 'src/test/kotlin/money/MoneyTest.kt')).toEqual(
      money,
    )
    expect(importsOf(graph, 'src/test/kotlin/app/WalletTest.kt')).toEqual(money)
  })
})

describe('Gradle wildcard imports', () => {
  test('a package wildcard import reaches the classes the test names', async () => {
    const root = await project({
      'src/main/java/lib/Tool.java': 'package lib;\n\npublic class Tool {}\n',
      'src/main/java/lib/Other.java': 'package lib;\n\npublic class Other {}\n',
      'src/test/java/app/ToolTest.java':
        'package app;\n\nimport lib.*;\n\nclass ToolTest {\n  Tool tool;\n}\n',
    })
    const graph = await graphOf(root)
    expect(importsOf(graph, 'src/test/java/app/ToolTest.java')).toEqual([
      'src/main/java/lib/Tool.java',
    ])
  })

  test('a static wildcard import reaches its class', async () => {
    const root = await project({
      'src/main/java/lib/Tool.java': 'package lib;\n\npublic class Tool {}\n',
      'src/test/java/app/StaticTest.java':
        'package app;\n\nimport static lib.Tool.*;\n\nclass StaticTest {}\n',
    })
    const graph = await graphOf(root)
    expect(importsOf(graph, 'src/test/java/app/StaticTest.java')).toEqual([
      'src/main/java/lib/Tool.java',
    ])
  })
})

describe('Gradle declarations', () => {
  test('every top-level type of a file resolves, including records and enums with nested types', async () => {
    const root = await project({
      'src/main/java/geo/Direction.java':
        'package geo;\n\npublic enum Direction {\n  NORTH;\n\n  interface Visitor {}\n}\n',
      'src/main/java/geo/Point.java':
        'package geo;\n\npublic record Point(int x, int y) {\n  public interface Shape {}\n}\n',
      'src/main/kotlin/shop/Models.kt':
        'package shop\n\ndata class Order(val id: String)\n\ndata class Line(val sku: String)\n',
      'src/test/java/app/GeoTest.java':
        'package app;\n\nimport geo.Direction;\nimport geo.Point;\n\nclass GeoTest {}\n',
      'src/test/kotlin/app/LineTest.kt':
        'package app\n\nimport shop.Line\n\nclass LineTest\n',
    })
    const graph = await graphOf(root)
    expect(importsOf(graph, 'src/test/java/app/GeoTest.java')).toEqual([
      'src/main/java/geo/Direction.java',
      'src/main/java/geo/Point.java',
    ])
    expect(importsOf(graph, 'src/test/kotlin/app/LineTest.kt')).toEqual([
      'src/main/kotlin/shop/Models.kt',
    ])
  })

  test('helpers and fixtures shared by tests are dependencies, and a test has no import edge to itself', async () => {
    const root = await project({
      'src/test/java/support/Fixtures.java':
        'package support;\n\nimport app.UsesFixturesTest;\n\npublic class Fixtures {}\n',
      'src/test/java/app/UsesFixturesTest.java':
        'package app;\n\nimport support.Fixtures;\n\nclass UsesFixturesTest {}\n',
      'src/testFixtures/java/fx/Builders.java':
        'package fx;\n\npublic class Builders {}\n',
      'src/test/java/app/UsesBuildersTest.java':
        'package app;\n\nimport fx.Builders;\n\nclass UsesBuildersTest {}\n',
    })
    const graph = await graphOf(root)
    expect(importsOf(graph, 'src/test/java/app/UsesFixturesTest.java')).toEqual(
      ['src/test/java/support/Fixtures.java'],
    )
    expect(importsOf(graph, 'src/test/java/app/UsesBuildersTest.java')).toEqual(
      ['src/testFixtures/java/fx/Builders.java'],
    )
    expect(graph.knownSources).toContain(
      'src/testFixtures/java/fx/Builders.java',
    )
    expect(
      await selected(root, graph, ['src/test/java/support/Fixtures.java']),
    ).toEqual([
      'gradle-junit:app:src/test/java/app/UsesFixturesTest.java',
      'gradle-junit:app:src/test/java/support/Fixtures.java',
    ])
    expect(
      await selected(root, graph, ['src/testFixtures/java/fx/Builders.java']),
    ).toEqual(['gradle-junit:app:src/test/java/app/UsesBuildersTest.java'])
  })

  test('build logic under buildSrc is not a production source', async () => {
    const root = await project({
      'buildSrc/src/main/kotlin/Deps.kt':
        'object Deps {\n  const val junit = "5.10.0"\n}\n',
      'src/test/java/a/OneTest.java': 'package a;\n\nclass OneTest {}\n',
    })
    const graph = await graphOf(root)
    expect(graph.knownSources).toEqual(['src/test/java/a/OneTest.java'])
    expect(
      await planGradle({
        changes: ['buildSrc/src/main/kotlin/Deps.kt'],
        currentEnvironmentFingerprint: 'env',
        graph,
        onUnknownChange: 'ignore',
        project: 'app',
        root,
      }),
    ).toMatchObject({
      mode: 'full',
      reason: 'Gradle build logic changed: buildSrc/src/main/kotlin/Deps.kt',
    })
  })
})

describe('Gradle test files', () => {
  test('a test under a path with glob characters keeps its imports', async () => {
    const root = await project({
      'mod (copy)/src/main/java/m/Dep.java':
        'package m;\n\npublic class Dep {}\n',
      'mod (copy)/src/test/java/m/DepTest.java':
        'package m;\n\nimport m.Dep;\n\nclass DepTest {}\n',
    })
    const graph = await graphOf(root)
    expect(importsOf(graph, 'mod (copy)/src/test/java/m/DepTest.java')).toEqual(
      ['mod (copy)/src/main/java/m/Dep.java'],
    )
  })

  test('a suite whose file is gone records only its own file', async () => {
    const root = await project({
      'src/test/java/a/OneTest.java': 'package a;\n\nclass OneTest {}\n',
    })
    const suites = await discoverGradleSuites({ project: 'app', root })
    const graph = await createGradleGraph(root, {
      environmentFingerprint: 'env',
      suites: [
        ...suites,
        {
          adapter: 'gradle-junit',
          className: 'a.GoneTest',
          file: 'src/test/java/a/GoneTest.java',
          id: 'gradle-junit:app:src/test/java/a/GoneTest.java',
          project: 'app',
        },
      ],
    })
    expect(
      graph.observations.map(({ kind, source }) => [source, kind]),
    ).toEqual([
      ['src/test/java/a/OneTest.java', 'configuration'],
      ['src/test/java/a/GoneTest.java', 'configuration'],
    ])
  })
})
