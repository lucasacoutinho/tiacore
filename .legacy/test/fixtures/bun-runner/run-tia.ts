import { tia } from '@lucasacoutinho/tiacore/bun'

const result = await tia({
  files: ['test/**/*.test.ts'],
  log: true,
}).run()

process.exitCode = result.success ? 0 : 1
