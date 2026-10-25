import { readdirSync } from 'node:fs'
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
  /**
   * Largest allowed growth in active libuv handles (timers, sockets, child
   * processes, pending file requests) and in open file descriptors across the
   * measured batches. Defaults to 3 of each: a few are transient. Pass
   * `false` to skip the check.
   */
  readonly handles?: number | false
}

export interface LeakResult {
  readonly bytesPerOperation: number
  /** Growth in open file descriptors, or null where the platform cannot list them. */
  readonly descriptorGrowth: number | null
  /** Growth in active handles and pending requests. */
  readonly handleGrowth: number
}

/** The number of open file descriptors, or null where the platform cannot list them. */
export function openDescriptors(): number | null {
  for (const directory of ['/proc/self/fd', '/dev/fd']) {
    try {
      return readdirSync(directory).length
    } catch {
      // Try the next location.
    }
  }
  return null
}

/** Active handles and pending requests of this thread. */
export function activeHandles(): number {
  return process.getActiveResourcesInfo().length
}

/**
 * Waits for the active handles to fall to `maximum`, which proves that a
 * resource with a delayed close (a keep-alive socket, a timer) does go away.
 */
export async function waitForHandles(
  maximum: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (activeHandles() > maximum) {
    if (Date.now() > deadline) {
      throw new Error(
        `${activeHandles()} handles are still active after ${timeoutMs} ms (expected at most ${maximum}): ${process.getActiveResourcesInfo().join(', ')}`,
      )
    }
    await pause(50)
  }
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

/** Lets closed sockets, exited children and finished timers leave the counts. */
async function settleHandles(): Promise<{
  descriptors: number | null
  handles: number
}> {
  let previous = -1
  let reading = { descriptors: openDescriptors(), handles: activeHandles() }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await pause(25)
    reading = { descriptors: openDescriptors(), handles: activeHandles() }
    const signature = reading.handles * 10_000 + (reading.descriptors ?? 0)
    if (signature === previous) break
    previous = signature
  }
  return reading
}

/**
 * Runs `operation` in batches and fails when retained heap keeps growing:
 * growth from the first to the last measured batch, divided by the number of
 * operations between them, must stay under `bytesPerOperation`. It also fails
 * when active handles or open file descriptors keep growing by more than
 * `handles`.
 */
export async function assertNoLeak(
  operation: () => unknown,
  options: LeakOptions,
): Promise<LeakResult> {
  const batches = options.batches ?? 4
  const run = async () => {
    for (let index = 0; index < options.iterations; index += 1) {
      await operation()
    }
  }
  await run()
  const handlesBefore = await settleHandles()
  const start = settledHeap()
  for (let batch = 0; batch < batches; batch += 1) await run()
  const handlesAfter = await settleHandles()
  const growth = settledHeap() - start
  const perOperation = growth / (batches * options.iterations)
  if (perOperation > options.bytesPerOperation) {
    throw new Error(
      `retained heap grew ${growth} bytes over ${batches * options.iterations} operations (${perOperation.toFixed(1)} bytes each, limit ${options.bytesPerOperation})`,
    )
  }
  const handleGrowth = handlesAfter.handles - handlesBefore.handles
  const descriptorGrowth =
    handlesAfter.descriptors === null || handlesBefore.descriptors === null
      ? null
      : handlesAfter.descriptors - handlesBefore.descriptors
  const limit = options.handles === undefined ? 3 : options.handles
  if (limit !== false) {
    if (handleGrowth > limit) {
      throw new Error(
        `active handles grew by ${handleGrowth} over ${batches * options.iterations} operations (limit ${limit}): ${process.getActiveResourcesInfo().join(', ')}`,
      )
    }
    if (descriptorGrowth !== null && descriptorGrowth > limit) {
      throw new Error(
        `open file descriptors grew by ${descriptorGrowth} over ${batches * options.iterations} operations (limit ${limit})`,
      )
    }
  }
  return { bytesPerOperation: perOperation, descriptorGrowth, handleGrowth }
}
