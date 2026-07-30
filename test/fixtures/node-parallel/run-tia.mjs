import { tia } from '@usescherie/tiacore/node'

const result = await tia({
  concurrency: Number(process.env.TIA_CONCURRENCY ?? 2),
  files: ['test/**/*.test.mjs'],
  log: true,
}).run()

process.exitCode = result.success ? 0 : 1
