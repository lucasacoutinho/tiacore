// Runs Vitest programmatically, several instances in this one process.
// Argument: a JSON list of steps, run in order.
//   { "append": "src/a.ts" }       appends a comment line to a tracked file
//   { "phase": "two" }             writes the file the test files read
//   { "wave": [ { "include": [...] }, ... ], "concurrent": true }
//                                  starts one Vitest instance per entry, one
//                                  after another or all at once
// Prints one line, `RESULT <json>`: per wave, the sorted test executions the
// wave logged and, per instance, its failed test count and how many reporter
// objects plugins added to it.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'

import { createVitest } from 'vitest/node'

const root = process.cwd()

function takeExecutions() {
  const lines = existsSync('executions.log')
    ? readFileSync('executions.log', 'utf8').split('\n').filter(Boolean)
    : []
  writeFileSync('executions.log', '')
  return lines.sort()
}

async function instance({ include }) {
  const vitest = await createVitest('test', {
    root,
    watch: false,
    ...(include === undefined ? {} : { include }),
  })
  // A plugin adds its reporter as an object; Vitest's own are names or pairs.
  const reporters = vitest.config.reporters.filter(
    (reporter) =>
      typeof reporter === 'object' &&
      !Array.isArray(reporter) &&
      typeof reporter.onTestRunEnd === 'function',
  ).length
  try {
    await vitest.start()
  } catch (error) {
    // start() throws when a replay selects no test file; the CLI ignores it.
    if (error?.code !== 'VITEST_FILES_NOT_FOUND') throw error
  }
  const failed = vitest.state.getCountOfFailedTests()
  await vitest.close()
  return { failed, reporters }
}

const waves = []
for (const step of JSON.parse(process.argv[2] ?? '[]')) {
  if (step.append !== undefined) {
    appendFileSync(step.append, '\n// edited\n')
  } else if (step.phase !== undefined) {
    writeFileSync('phase.txt', `${step.phase}\n`)
  } else {
    const entries = step.wave
    const instances = step.concurrent
      ? await Promise.all(entries.map(instance))
      : []
    if (!step.concurrent) {
      for (const entry of entries) instances.push(await instance(entry))
    }
    waves.push({ executions: takeExecutions(), instances })
  }
}
process.stdout.write(`RESULT ${JSON.stringify(waves)}\n`)
