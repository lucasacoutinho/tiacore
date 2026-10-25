import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { VERSION } from '../core/version.ts'

/** Runs the tiacore CLI with `argv`; throws with the failure message. */
export async function runCli(argv: readonly string[]): Promise<void> {
  const cli = await import('../cli/main.ts')
  await cli.runCli(argv)
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  const { execute } = await import('../cli/main.ts')
  const { disposeHost } = await import('../host/runtime.ts')
  try {
    const outcome = await execute(argv)
    if (outcome.message !== undefined)
      process.stderr.write(`${outcome.message}\n`)
    process.exitCode = outcome.code
  } finally {
    // Flushes the exporters TIACORE_* enabled and lets the process exit.
    await disposeHost()
  }
}

const invokedPath = process.argv[1]
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(invokedPath)).href
) {
  await main(process.argv.slice(2))
}
