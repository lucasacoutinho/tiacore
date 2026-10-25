import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

export async function recordSpan(name, peer) {
  mkdirSync('spans', { recursive: true })
  const start = Date.now()
  writeFileSync(`spans/${name}.started`, '')

  if (process.env.TIA_EXPECT_PARALLEL === '1') {
    const deadline = Date.now() + 5_000
    while (!existsSync(`spans/${peer}.started`)) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for concurrent ${peer}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  } else {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  writeFileSync(
    `spans/${name}.json`,
    JSON.stringify({ end: Date.now(), start }),
  )
}
