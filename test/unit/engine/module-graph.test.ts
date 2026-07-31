import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  directlyImportedAssetFiles,
  importedAssetFiles,
  type ModuleGraphLike,
} from '../../../src/adapters/vitest/module-graph.js'

interface FakeNode {
  file: string | null
  id: string | null
  importedModules: Set<FakeNode>
}

function node(file: string | null, id = file): FakeNode {
  return {
    file,
    id,
    importedModules: new Set(),
  }
}

describe('Vite module graph assets', () => {
  test('collects nested project assets without replacing runtime JS edges', () => {
    const root = resolve('/project')
    const testFile = node(resolve(root, 'test/button.test.tsx'))
    const component = node(resolve(root, 'src/Button.tsx'))
    const css = node(resolve(root, 'src/Button.module.css'))
    const json = node(resolve(root, 'src/labels.json'))
    const svg = node(null, `${resolve(root, 'src/icon.svg')}?raw`)
    const external = node('/dependencies/theme.css')

    testFile.importedModules.add(component)
    component.importedModules.add(css)
    component.importedModules.add(json)
    component.importedModules.add(svg)
    component.importedModules.add(external)
    css.importedModules.add(component)

    const graph: ModuleGraphLike = {
      getModuleById: (id) => (id === testFile.id ? testFile : undefined),
      getModulesByFile: () => undefined,
    }

    expect(importedAssetFiles(graph, testFile.id!, root)).toEqual([
      'src/Button.module.css',
      'src/icon.svg',
      'src/labels.json',
    ])
  })

  test('finds entry variants by their physical file', () => {
    const root = resolve('/project')
    const testFile = node(resolve(root, 'test/example.test.ts'))
    const asset = node(resolve(root, 'src/data.json'))
    testFile.importedModules.add(asset)

    const graph: ModuleGraphLike = {
      getModuleById: () => undefined,
      getModulesByFile: (file) =>
        file === testFile.file ? new Set([testFile]) : undefined,
    }

    expect(importedAssetFiles(graph, `${testFile.file}?v=1`, root)).toEqual([
      'src/data.json',
    ])
  })

  test('distinguishes direct assets from assets behind executable modules', () => {
    const root = resolve('/project')
    const testFile = node(resolve(root, 'test/example.test.ts'))
    const directCss = node(resolve(root, 'test/test.css'))
    const source = node(resolve(root, 'src/example.ts'))
    const sourceCss = node(resolve(root, 'src/example.css'))
    testFile.importedModules.add(directCss)
    testFile.importedModules.add(source)
    source.importedModules.add(sourceCss)

    const graph: ModuleGraphLike = {
      getModuleById: (id) => (id === testFile.id ? testFile : undefined),
      getModulesByFile: () => undefined,
    }

    expect(directlyImportedAssetFiles(graph, testFile.id!, root)).toEqual([
      'test/test.css',
    ])
    expect(importedAssetFiles(graph, testFile.id!, root)).toEqual([
      'src/example.css',
      'test/test.css',
    ])
  })
})
