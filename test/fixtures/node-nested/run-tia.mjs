import { tia } from '@usescherie/tiacore/node'

const result = await tia({
  files: ['test/**/*.test.mjs', 'test/**/*.test.cjs'],
  log: true,
}).run()

process.exitCode = result.success ? 0 : 1
