import * as NodeServices from '@effect/platform-node/NodeServices'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import { expect, layer } from '@effect/vitest'

import type { TiaImpactGraph, TiaImpactPlan } from '../../src/core/protocol.ts'
import { writeProtocolVerificationSnapshot } from '../../src/engine/verification-snapshot.ts'
import { tempDirectory } from './support/layers.ts'

const snapshot = (directory: string, outcomes: Record<string, unknown>) =>
  writeProtocolVerificationSnapshot({
    executed: ['suite'],
    // Only the fingerprint names the file; the rest is written as given.
    graph: { fingerprint: 'fingerprint' } as unknown as TiaImpactGraph,
    outcomes: outcomes as never,
    plan: {} as TiaImpactPlan,
    runner: 'k6',
    success: true,
    target: { directory, phase: 'full' },
  })

layer(NodeServices.layer, { excludeTestServices: true })(
  'verification snapshot',
  (it) => {
    it.effect('leaves no partial file behind when writing fails', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* tempDirectory('tia-snapshot-')
        yield* snapshot(directory, {})
        const written = yield* fs.readDirectory(join(directory, 'full'))
        // A BigInt cannot be serialized: the write fails part way.
        const failed = yield* Effect.exit(snapshot(directory, { suite: 1n }))
        const left = yield* fs.readDirectory(join(directory, 'full'))
        expect(written).toHaveLength(1)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(left).toEqual(written)
      }),
    )
  },
)
