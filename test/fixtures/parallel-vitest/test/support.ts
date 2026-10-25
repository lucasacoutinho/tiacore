import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { threadId } from 'node:worker_threads'

export async function measured(
  id: string,
  assertion: () => void,
): Promise<void> {
  appendFileSync('executions.log', `${id}\n`)
  const start = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 120))
  assertion()
  const end = Date.now()

  mkdirSync('spans', { recursive: true })
  writeFileSync(
    `spans/${id}.json`,
    `${JSON.stringify({ end, id, pid: process.pid, start, threadId })}\n`,
  )
}
