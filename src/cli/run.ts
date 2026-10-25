import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'

import { loadWorkspace } from '../assurance/workspace/config.ts'
import { TiaFailed, TiaInvalid } from '../wire/errors.ts'
import { emitJson } from './io.ts'

export const runCommand = Command.make(
  'run',
  {
    config: Flag.String('config').pipe(
      Flag.withDescription('workspace config module'),
      Flag.withDefault('tiacore.config.mjs'),
    ),
    output: Flag.String('output').pipe(
      Flag.withDescription('write the workspace receipt'),
      Flag.optional,
    ),
  },
  Effect.fn('tia.cli.run')(function* (options) {
    const workspace = yield* loadWorkspace(options.config)
    const result = yield* Effect.tryPromise({
      catch: (error) =>
        new TiaInvalid({
          message: error instanceof Error ? error.message : String(error),
        }),
      try: () => workspace.run(),
    })
    yield* emitJson(result, Option.getOrUndefined(options.output))
    const succeeded =
      Predicate.hasProperty(result, 'success') && Boolean(result.success)
    if (!succeeded) {
      return yield* new TiaFailed({
        message: 'TIA workspace run did not succeed',
      })
    }
  }),
).pipe(Command.withDescription('Run configured workspace lanes'))
