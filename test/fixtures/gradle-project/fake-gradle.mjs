import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const classes = process.argv.flatMap((value, index, values) =>
  values[index - 1] === '--tests' ? [value] : [],
)
const log = process.env.TIACORE_GRADLE_LOG
if (log) appendFileSync(log, `${process.argv.slice(2).join(' ')}\n`)
if (process.env.TIACORE_GRADLE_PROCESS_FAILURE === '1') {
  process.exitCode = 7
} else if (process.env.TIACORE_GRADLE_SKIP_REPORTS !== '1') {
const reports = join(process.cwd(), 'build/test-results/test')
mkdirSync(reports, { recursive: true })
writeFileSync(
  join(reports, 'TEST-tiacore.xml'),
  `<testsuite tests="${classes.length}">${classes.map((name) =>
    process.env.TIACORE_GRADLE_TEST_FAILURE === '1'
      ? `<testcase classname="${name}" name="fails"><failure/></testcase>`
      : `<testcase classname="${name}" name="works" time="0.01"/>`,
  ).join('')}</testsuite>`,
)
}
