import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [modulePath, cacheDir, expectedPath, proposedPath] = process.argv.slice(2)
if (
  modulePath === undefined ||
  cacheDir === undefined ||
  expectedPath === undefined ||
  proposedPath === undefined
) {
  process.exitCode = 64
} else {
  const { commitGraph, graphDigest } = await import(
    pathToFileURL(modulePath).href
  )
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
  const graph = JSON.parse(readFileSync(proposedPath, 'utf8'))
  const result = await commitGraph(cacheDir, {
    expected,
    expectedDigest: graphDigest(expected),
    graph,
  })
  process.stdout.write(`${result.status}\n`)
  if (result.status === 'conflict') {
    process.exitCode = 2
  }
}
