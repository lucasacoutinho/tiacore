import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { describe, expect, test } from 'vitest'

import {
  errorMessage,
  ioError,
  systemIoError,
  TiaIo,
} from '../../src/wire/errors.ts'

const missing = '/nonexistent/tiacore-errors-test'

const platformFailure = () =>
  Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.readFileString(missing),
    ).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
  )

describe('errorMessage', () => {
  test('is an Error message, or the value as text', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(null)).toBe('null')
  })
})

describe('ioError', () => {
  test('keeps the failure as the cause and its text as the message', () => {
    const cause = new Error('disk full')
    const failure = ioError(cause)
    expect(failure).toBeInstanceOf(TiaIo)
    expect(failure.message).toBe('disk full')
    expect(failure.cause).toBe(cause)
    expect(ioError('nope').message).toBe('nope')
  })

  test('reports a platform error with the platform text', async () => {
    const failure = await platformFailure()
    expect(ioError(failure).message).toBe(failure.message)
    expect(failure.message).toContain('FileSystem.readFile')
  })
})

describe('systemIoError', () => {
  test('reports the Node error a platform error wraps, as 1.x did', async () => {
    const failure = await platformFailure()
    expect(systemIoError(failure).message).toMatch(
      /^ENOENT: no such file or directory, open /u,
    )
    expect(systemIoError(failure).cause).toBe(failure)
  })

  test('falls back to its own message without a wrapped Error', () => {
    expect(systemIoError(new Error('plain')).message).toBe('plain')
  })
})
