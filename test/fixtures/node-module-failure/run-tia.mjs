import { tia } from '@usescherie/tiacore/node'

const result = await tia({
  files: ['test/**/*.test.mjs'],
  log: true,
}).run()

process.exitCode = result.success ? 0 : 1
