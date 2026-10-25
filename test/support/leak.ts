import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void

function settledHeap(): number {
  for (let pass = 0; pass < 3; pass += 1) collect()
  return process.memoryUsage().heapUsed
}

export interface LeakOptions {
  /** Batches measured after warm-up; the heap must stop growing across them. */
  readonly batches?: number
  /** Operations per batch. */
  readonly iterations: number
  /** Largest allowed retained growth per operation, in bytes. */
  readonly bytesPerOperation: number
}

/**
 * Runs `operation` in batches and fails when retained heap keeps growing:
 * growth from the first to the last measured batch, divided by the number of
 * operations between them, must stay under `bytesPerOperation`.
 */
export async function assertNoLeak(
  operation: () => unknown,
  options: LeakOptions,
): Promise<{ bytesPerOperation: number }> {
  const batches = options.batches ?? 4
  const run = async () => {
    for (let index = 0; index < options.iterations; index += 1) {
      await operation()
    }
  }
  await run()
  const start = settledHeap()
  for (let batch = 0; batch < batches; batch += 1) await run()
  const growth = settledHeap() - start
  const perOperation = growth / (batches * options.iterations)
  if (perOperation > options.bytesPerOperation) {
    throw new Error(
      `retained heap grew ${growth} bytes over ${batches * options.iterations} operations (${perOperation.toFixed(1)} bytes each, limit ${options.bytesPerOperation})`,
    )
  }
  return { bytesPerOperation: perOperation }
}
