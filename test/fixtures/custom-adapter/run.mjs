import { appendFileSync } from 'node:fs'

import {
  tia,
  TIA_TYPESCRIPT_ADAPTER_VERSION,
} from '@usescherie/tiacore/adapter'

const runner = tia({
  apiVersion: TIA_TYPESCRIPT_ADAPTER_VERSION,
  discover() {
    return {
      files: ['run.mjs'],
      tests: [{
        file: 'test/value.test.mjs',
        fullName: 'external adapter value case',
        id: 'external:value',
      }],
    }
  },
  async execute({ tests }) {
    const { value } = await import(`./src/value.mjs?run=${Date.now()}`)
    return {
      complete: true,
      observations: tests.map((test) => {
        appendFileSync('executions.log', `${test.id}:${value}\n`)
        return {
          file: test.file,
          files: [test.file, 'src/value.mjs'],
          fullName: test.fullName,
          id: test.id,
          state: value > 0 ? 'passed' : 'failed',
        }
      }),
    }
  },
  features: ['cached-outcomes'],
  name: 'external-adapter',
  version: '1.0.0',
}, { log: false })

const result = await runner.run()
console.log(JSON.stringify({
  mode: result.plan.mode,
  replayedTests: result.replayedTests,
  selectedTests: result.selectedTests,
  success: result.success,
}))
process.exitCode = result.success ? 0 : 1
