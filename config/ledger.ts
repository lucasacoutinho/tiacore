// Usage:
//   node config/ledger.ts port <legacy test file> <2.0 test file>
//       maps every 1.x test of that file to its 2.0 file in the ledger
//   node config/ledger.ts exports
//       rebuilds test/package/pending-exports.json from the built entries
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const LEDGER = 'test/package/legacy-tests.json'
const PENDING = 'test/package/pending-exports.json'

const [command, legacyFile, target] = process.argv.slice(2)
if (command === 'port' && legacyFile !== undefined && target !== undefined) {
  const ledger: Record<string, string> = JSON.parse(
    readFileSync(LEDGER, 'utf8'),
  )
  let count = 0
  for (const key of Object.keys(ledger)) {
    if (key.startsWith(`${legacyFile} > `)) {
      ledger[key] = target
      count += 1
    }
  }
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`)
  console.log(`${count} tests of ${legacyFile} -> ${target}`)
} else if (command === 'exports') {
  const legacy: Record<string, string[]> = JSON.parse(
    readFileSync('test/package/legacy-exports.json', 'utf8'),
  )
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const pending: string[] = []
  for (const [subpath, names] of Object.entries(legacy)) {
    const file =
      subpath === 'bin'
        ? manifest.bin.tiacore
        : manifest.exports[subpath].default
    const module: object = await import(pathToFileURL(file).href)
    for (const name of names)
      if (!(name in module)) pending.push(`${subpath} ${name}`)
  }
  writeFileSync(PENDING, `${JSON.stringify(pending.sort(), null, 2)}\n`)
  console.log(`${pending.length} exports pending`)
} else {
  console.error('usage: node config/ledger.ts port <legacy> <target> | exports')
  process.exitCode = 2
}
