import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  directlyImportedAssetFiles,
  importedAssetFiles,
  type ModuleGraphLike,
} from '../../../src/runners/vitest/module-graph.ts'
import { legacy } from '../../support/legacy.ts'

const oracle = await legacy<{
  directlyImportedAssetFiles: typeof directlyImportedAssetFiles
  importedAssetFiles: typeof importedAssetFiles
}>('adapters/vitest/module-graph.js')

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

// A graph with every shape the walk has to handle: cycles, query variants,
// executable and asset modules, assets outside the root, the root itself and
// nodes that carry only an id.
function world() {
  const root = resolve('/project')
  const entry = node(resolve(root, 'test/entry.test.ts'))
  const helper = node(resolve(root, 'test/helper.mts'))
  const component = node(resolve(root, 'src/App.vue'))
  const style = node(resolve(root, 'src/app.scss'))
  const upper = node(resolve(root, 'src/Types.D.TS'))
  const imageByQuery = node(null, `${resolve(root, 'src/logo.png')}?url`)
  const dotAsset = node(resolve(root, '.env.test'))
  const outside = node('/elsewhere/shared.css')
  const rootItself = node(root)
  const nested = node(resolve(root, 'src/deep/data.yaml'))

  entry.importedModules.add(helper)
  entry.importedModules.add(imageByQuery)
  helper.importedModules.add(component)
  helper.importedModules.add(entry)
  component.importedModules.add(style)
  component.importedModules.add(upper)
  component.importedModules.add(outside)
  component.importedModules.add(nested)
  style.importedModules.add(dotAsset)
  style.importedModules.add(rootItself)

  const modules = [
    entry,
    helper,
    component,
    style,
    upper,
    imageByQuery,
    dotAsset,
    outside,
    rootItself,
    nested,
  ]
  const graph: ModuleGraphLike = {
    getModuleById: (id) => modules.find((candidate) => candidate.id === id),
    getModulesByFile: (file) => {
      const found = modules.filter((candidate) => candidate.file === file)
      return found.length === 0 ? undefined : new Set(found)
    },
  }
  return { entry, graph, root }
}

describe('Vite module graph assets match 1.x', () => {
  test.each([
    ['by id', (entry: FakeNode) => entry.id!],
    ['by id with a query', (entry: FakeNode) => `${entry.id}?v=2`],
    ['an unknown module', () => resolve('/project/test/missing.test.ts')],
  ])('walks the same assets (%s)', (_, moduleId) => {
    const { entry, graph, root } = world()
    const id = moduleId(entry)

    expect(importedAssetFiles(graph, id, root)).toEqual(
      oracle.importedAssetFiles(graph, id, root),
    )
    expect(directlyImportedAssetFiles(graph, id, root)).toEqual(
      oracle.directlyImportedAssetFiles(graph, id, root),
    )
  })

  test('finds the assets the fixture is built to contain', () => {
    const { entry, graph, root } = world()

    // Only .js/.ts-style extensions count as executable, in any case; a .vue
    // component is not one, so it is reported as an asset.
    expect(importedAssetFiles(graph, entry.id!, root)).toEqual([
      '.env.test',
      'src/App.vue',
      'src/app.scss',
      'src/deep/data.yaml',
      'src/logo.png',
    ])
    expect(directlyImportedAssetFiles(graph, entry.id!, root)).toEqual([
      'src/logo.png',
    ])
  })
})
