import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { VERSION } from '../core/version.ts'

function main(argv: readonly string[]): void {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  process.stderr.write('tiacore 2.0 CLI is not implemented yet\n')
  process.exitCode = 1
}

const invokedPath = process.argv[1]
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(invokedPath)).href
) {
  main(process.argv.slice(2))
}
