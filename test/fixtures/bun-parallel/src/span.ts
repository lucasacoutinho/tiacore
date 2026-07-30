import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

export async function recordSpan(name: string, peer: string): Promise<void> {
  mkdirSync('spans', { recursive: true })
  const start = Date.now()
  writeFileSync(`spans/${name}.started`, '')

  if (process.env.TIA_EXPECT_PARALLEL === '1') {
    const deadline = Date.now() + 5_000
    while (!existsSync(`spans/${peer}.started`)) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for concurrent ${peer}`)
      }
      await Bun.sleep(10)
    }
  } else {
    await Bun.sleep(50)
  }

  writeFileSync(
    `spans/${name}.json`,
    JSON.stringify({ end: Date.now(), start }),
  )
}
