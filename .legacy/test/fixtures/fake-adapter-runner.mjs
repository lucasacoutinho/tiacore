import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'

const file = process.argv.at(-1)
const log = process.env.TIACORE_FAKE_RUNNER_LOG
if (file === undefined || log === undefined) {
  throw new Error('fake adapter runner requires a file and log destination')
}

appendFileSync(log, `${relative(process.cwd(), file).replaceAll('\\', '/')}\n`)
if (
  process.env.TIACORE_FAKE_RUNNER_FAIL !== undefined &&
  file.includes(process.env.TIACORE_FAKE_RUNNER_FAIL)
) {
  process.exitCode = 7
}
