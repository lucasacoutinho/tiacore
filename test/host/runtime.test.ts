import * as Effect from 'effect/Effect'
import { afterAll, describe, expect, test } from 'vitest'

import { disposeHost, runPromise } from '../../src/host/runtime.ts'
import { TiaInvalid } from '../../src/wire/errors.ts'
import { assertNoLeak } from '../support/leak.ts'

afterAll(disposeHost)

describe('runPromise', () => {
  test('returns the program result', async () => {
    await expect(runPromise(Effect.succeed(42))).resolves.toBe(42)
  })

  test('throws a tagged failure as an Error with the 1.x message', async () => {
    const error = await runPromise(
      Effect.fail(new TiaInvalid({ message: 'unknown option --nope' })),
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ message: 'unknown option --nope' })
    expect((error as Error).cause).toBeInstanceOf(TiaInvalid)
  })

  test('rethrows defects unchanged', async () => {
    const defect = new RangeError('boom')
    await expect(runPromise(Effect.die(defect))).rejects.toBe(defect)
  })

  test('retains no memory across many runs', async () => {
    const success = await assertNoLeak(
      () => runPromise(Effect.succeed({ value: 'x'.repeat(64) })),
      {
        bytesPerOperation: 64,
        iterations: 2_000,
      },
    )
    const failure = await assertNoLeak(
      () =>
        runPromise(Effect.fail(new TiaInvalid({ message: 'invalid' }))).catch(
          () => undefined,
        ),
      { bytesPerOperation: 64, iterations: 2_000 },
    )
    expect(success.bytesPerOperation).toBeLessThan(64)
    expect(failure.bytesPerOperation).toBeLessThan(64)
  })

  test('the leak check fails on a real leak', async () => {
    const retained: string[] = []
    await expect(
      assertNoLeak(() => retained.push('x'.repeat(256)), {
        bytesPerOperation: 64,
        iterations: 2_000,
      }),
    ).rejects.toThrow(/retained heap grew/u)
  })
})
