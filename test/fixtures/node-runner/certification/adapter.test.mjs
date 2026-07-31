import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const { readGraph } = await import(
  new URL(
    '../node_modules/@usescherie/tiacore/dist/engine/state/store.js',
    import.meta.url,
  )
)

function run() {
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT

  return spawnSync(process.execPath, ['run-tia.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: environment,
  })
}

test('the installed Node adapter records once and replays from cache', () => {
  const root = resolve(import.meta.dirname, '..')
  rmSync(resolve(root, '.tia'), { force: true, recursive: true })
  rmSync(resolve(root, 'executions.log'), { force: true })

  const initial = run()
  assert.equal(initial.status, 0, `${initial.stdout}${initial.stderr}`)

  const replay = run()
  assert.equal(replay.status, 0, `${replay.stdout}${replay.stderr}`)
  assert.match(replay.stdout, /no affected test files/)
  assert.deepEqual(
    readFileSync(resolve(root, 'executions.log'), 'utf8')
      .trim()
      .split('\n')
      .sort(),
    ['node-a', 'node-b'],
  )

  const graph = readGraph(resolve(root, '.tia/node'))
  assert.ok(graph)
  const resultA = Object.values(graph.results).find(
    (result) => result.fullName === 'node case a',
  )
  assert.ok(resultA)
  const files = graph.testEdges[resultA.id].files
  const [major, minor] = process.versions.node.split('.').map(Number)
  const preciseDiscovery = major > 22 || (major === 22 && minor >= 15)

  if (preciseDiscovery) {
    assert.ok(files.includes('src/a.mjs'))
    assert.ok(!files.includes('src/b.mjs'))
  } else {
    assert.ok(files.includes('src/a.mjs'))
    assert.ok(files.includes('src/b.mjs'))
  }
})
