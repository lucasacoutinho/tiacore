import { tia } from '@lucasacoutinho/tiacore/bun'

const result = await tia({
  concurrency: Number(process.env.TIA_CONCURRENCY ?? 2),
  files: ['test/**/*.test.ts'],
  log: true,
}).run()

process.exitCode = result.success ? 0 : 1
