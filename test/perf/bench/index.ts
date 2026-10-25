import { cli } from './cli.ts'
import { effect } from './effect.ts'
import { cold, warm } from './engine.ts'
import { protocol } from './protocol.ts'
import { store } from './store.ts'
import { vitest } from './vitest.ts'
import type { Workload } from './workload.ts'

/** Every workload, in the order a full run takes them. */
export const workloads: readonly Workload[] = [
  cold,
  warm,
  vitest,
  effect,
  protocol,
  store,
  cli,
]
