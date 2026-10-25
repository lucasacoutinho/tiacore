import * as Argument from 'effect/cli/Argument'
import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import { verify } from '../assurance/verify/runner.ts'
import { TiaFailed, TiaInvalid } from '../wire/errors.ts'
import { emitJson } from './io.ts'

const optional = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional)

export const verifyCommand = Command.make(
  'verify',
  {
    artifacts: optional('artifacts', 'retain phase snapshots'),
    command: Argument.String('command').pipe(
      Argument.withDescription(
        'test command and its arguments; put it after `--` when it has options',
      ),
      Argument.atLeast(1),
    ),
    cwd: optional('cwd', 'test command working directory'),
    output: optional('output', 'write the verification receipt'),
  },
  Effect.fn('tia.cli.verify')(function* (options) {
    const [executable, ...rest] = options.command
    if (executable === undefined || executable.trim() === '') {
      return yield* new TiaInvalid({
        message: 'TIA verification command cannot be empty',
      })
    }
    const artifacts = Option.getOrUndefined(options.artifacts)
    const cwd = Option.getOrUndefined(options.cwd)
    const output = Option.getOrUndefined(options.output)
    const receipt = yield* verify({
      arguments: rest,
      command: executable,
      ...(artifacts === undefined
        ? {}
        : { artifactsDirectory: artifacts, keepArtifacts: true }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(output === undefined ? {} : { output }),
    })
    if (output === undefined) yield* emitJson(receipt, undefined)
    if (!receipt.success) {
      return yield* new TiaFailed({
        message: 'TIA verification did not succeed',
        silent: true,
      })
    }
  }),
).pipe(Command.withDescription('Compare selective and fresh full results'))
