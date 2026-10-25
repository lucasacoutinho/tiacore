import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { certifyAdapterReceipt } from '../assurance/certify/parse.ts'
import { executeCertification } from '../assurance/certify/execute.ts'
import { ExecutableSpec } from '../assurance/certify/spec.ts'
import { TiaFailed, TiaInvalid } from '../wire/errors.ts'
import { describeIssue } from '../wire/issue.ts'
import { attempt, emitJson, readJson } from './io.ts'

const decodeSpec = (value: unknown) =>
  Schema.decodeUnknownEffect(ExecutableSpec)(value).pipe(
    Effect.mapError(
      (error) =>
        new TiaInvalid({
          message: describeIssue(
            'TIA certification specification',
            error.issue,
          ),
        }),
    ),
  )

const adapter = Command.make(
  'adapter',
  {
    output: Flag.String('output').pipe(
      Flag.withDescription('write JSON to a file or -'),
      Flag.optional,
    ),
    receipt: Flag.String('receipt').pipe(
      Flag.withDescription('adapter receipt JSON'),
    ),
  },
  Effect.fn('tia.cli.certify.adapter')(function* (options) {
    const receipt = yield* readJson(options.receipt)
    const certification = yield* attempt(() => certifyAdapterReceipt(receipt))
    yield* emitJson(certification, Option.getOrUndefined(options.output))
  }),
).pipe(Command.withDescription('Validate an adapter certification receipt'))

const execute = Command.make(
  'execute',
  {
    output: Flag.String('output').pipe(
      Flag.withDescription('write the receipt to a file or -'),
      Flag.optional,
    ),
    spec: Flag.String('spec').pipe(
      Flag.withDescription('executable certification specification'),
    ),
  },
  Effect.fn('tia.cli.certify.execute')(function* (options) {
    const spec = yield* decodeSpec(yield* readJson(options.spec))
    const receipt = yield* executeCertification(spec)
    yield* emitJson(receipt, Option.getOrUndefined(options.output))
    // The receipt is written first so a failing run still leaves its evidence.
    yield* attempt(() => certifyAdapterReceipt(receipt)).pipe(
      Effect.mapError(
        (error) => new TiaFailed({ message: error.message, silent: true }),
      ),
    )
  }),
).pipe(
  Command.withDescription('Execute an adapter certification specification'),
)

export const certifyCommand = Command.make('certify').pipe(
  Command.withDescription('Certification commands'),
  Command.withSubcommands([adapter, execute]),
)
