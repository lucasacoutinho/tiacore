import { tia } from '@lucasacoutinho/tiacore/evidence'

const [correlationId, file, producer] = process.argv.slice(2)
const evidence = tia({
  directory: '.tia/evidence',
  producer,
  root: process.cwd(),
})
const observed = evidence.fromHeaders({
  'X-Tiacore-Correlation-Id': correlationId,
})

if (observed !== null) {
  await evidence.run(observed, () => evidence.record([file]))
}
