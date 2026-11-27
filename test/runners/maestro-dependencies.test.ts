import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { TiaImpactGraph } from '../../src/core/protocol.ts'
import {
  createMaestroGraph,
  discoverMaestroSuites,
  planMaestro,
} from '../../src/runners/maestro/index.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tiacore-maestro-dependencies-'))
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

const where = (root: string) => ({
  excludeTags: ['helper'],
  flows: 'e2e',
  project: 'p',
  root,
})

async function selected(
  root: string,
  graph: TiaImpactGraph,
  changes: string[],
): Promise<string[]> {
  const plan = await planMaestro({
    ...where(root),
    changes,
    currentEnvironmentFingerprint: 'env',
    graph,
  })
  return plan.selected
}

describe('Maestro flows behind an excluded helper', () => {
  test('a flow depends on the included flows it reaches through an excluded helper', async () => {
    const root = await project({
      'e2e/checkout.yaml':
        'appId: app\ntags: [smoke]\n---\n- runFlow: helpers/login.yaml\n',
      'e2e/helpers/login.yaml':
        'appId: app\ntags: [helper]\n---\n- runFlow: ../account.yaml\n',
      'e2e/account.yaml': 'appId: app\ntags: [smoke]\n---\n- launchApp\n',
    })
    const suites = await discoverMaestroSuites(where(root))
    expect(suites.map((suite) => [suite.file, suite.dependsOn])).toEqual([
      ['e2e/account.yaml', []],
      ['e2e/checkout.yaml', ['maestro:p:e2e/account.yaml']],
    ])
    const graph = createMaestroGraph({ environmentFingerprint: 'env', suites })
    expect(await selected(root, graph, ['e2e/account.yaml'])).toEqual([
      'maestro:p:e2e/account.yaml',
      'maestro:p:e2e/checkout.yaml',
    ])
  })
})
