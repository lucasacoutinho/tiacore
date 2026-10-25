import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import { publishGraph } from '../engine/artifacts/publish.ts'
import { GraphStoreLive } from '../engine/state/graph-store.ts'
import { TiaInvalid } from '../wire/errors.ts'
import { emitJson } from './io.ts'

// `tiacore artifacts publish|promote`. Both subcommands share one flag set and
// differ only in whether the graph is promoted.

const options = {
  artifactId: Flag.String('artifact-id').pipe(
    Flag.withDescription('artifact identifier'),
  ),
  baseUrl: Flag.String('base-url').pipe(
    Flag.withDescription('public base URL for output files'),
    Flag.optional,
  ),
  cacheDir: Flag.String('cache-dir').pipe(
    Flag.withDescription('graph cache directory'),
    Flag.withDefault('.tia'),
  ),
  group: Flag.String('group').pipe(
    Flag.withDescription('partition group identifier'),
    Flag.optional,
  ),
  keep: Flag.Int('keep').pipe(
    Flag.withDescription('newest archives kept in the output directory'),
    Flag.optional,
  ),
  maxAgeDays: Flag.Finite('max-age-days').pipe(
    Flag.withDescription('also prune archives older than this many days'),
    Flag.optional,
  ),
  outputDir: Flag.String('output-dir').pipe(
    Flag.withDescription('artifact output directory'),
    Flag.withDefault('.tia-artifacts'),
  ),
  parent: Flag.String('parent').pipe(
    Flag.withDescription('parent artifact ID; repeat as needed'),
    Flag.atLeast(0),
  ),
  producer: Flag.String('producer').pipe(
    Flag.withDescription('producing system name'),
    Flag.optional,
  ),
  prune: Flag.Boolean('prune').pipe(
    Flag.withDescription(
      'prune old archives from the output directory; --no-prune keeps them all',
    ),
    Flag.withDefault(true),
  ),
  receipt: Flag.String('receipt').pipe(
    Flag.withDescription('write the publication receipt to a file or -'),
    Flag.optional,
  ),
  requireCoverage: Flag.Boolean('require-coverage').pipe(
    Flag.withDescription('require complete coverage for promotion'),
    Flag.withDefault(false),
  ),
  root: Flag.String('root').pipe(
    Flag.withDescription('repository root'),
    Flag.optional,
  ),
  runId: Flag.String('run-id').pipe(
    Flag.withDescription('producing run identifier'),
  ),
  runner: Flag.String('runner').pipe(
    Flag.withDescription('runner namespace in the archive'),
    Flag.optional,
  ),
  signingKeyEnv: Flag.String('signing-key-env').pipe(
    Flag.withDescription(
      'environment variable containing an Ed25519 private key (PEM, or base64 DER)',
    ),
    Flag.withDefault('TIA_ARTIFACT_PRIVATE_KEY'),
  ),
  signingKeyId: Flag.String('signing-key-id').pipe(
    Flag.withDescription('trusted signing key identifier'),
  ),
  trustExpiresIn: Flag.String('trust-expires-in').pipe(
    Flag.withDescription('attestation lifetime in seconds'),
    Flag.withDefault('604800'),
  ),
}

const some = <A, K extends string>(key: K, value: Option.Option<A>) =>
  Option.match(value, {
    onNone: () => ({}),
    onSome: (present) => ({ [key]: present }),
  })

const artifactCommand = (
  name: string,
  description: string,
  promoted: boolean,
) =>
  Command.make(
    name,
    options,
    Effect.fn(`tia.cli.artifacts.${name}`)(function* (flags) {
      const secret = process.env[flags.signingKeyEnv]
      if (secret === undefined || secret.trim() === '') {
        return yield* new TiaInvalid({
          message: `TIA artifact signing key is missing from ${flags.signingKeyEnv}`,
        })
      }
      const receipt = yield* publishGraph(
        {
          artifactId: flags.artifactId,
          cacheDir: flags.cacheDir,
          filesystem: {
            ...some('baseUrl', flags.baseUrl),
            directory: flags.outputDir,
            retention: flags.prune
              ? {
                  ...some('keep', flags.keep),
                  ...some('maxAgeDays', flags.maxAgeDays),
                }
              : false,
          },
          ...some('group', flags.group),
          parents: [...flags.parent],
          ...some('producer', flags.producer),
          requireCoverage: flags.requireCoverage,
          ...some('root', flags.root),
          runId: flags.runId,
          ...some('runner', flags.runner),
          signing: {
            expiresInSeconds: Number(flags.trustExpiresIn),
            keyId: flags.signingKeyId,
            privateKey: secret,
          },
        },
        promoted,
      ).pipe(Effect.provide(GraphStoreLive))
      yield* emitJson(receipt, Option.getOrUndefined(flags.receipt))
    }),
  ).pipe(Command.withDescription(description))

export const artifactsCommand = Command.make('artifacts').pipe(
  Command.withDescription('Publish provider-neutral graph artifacts'),
  Command.withSubcommands([
    artifactCommand('publish', 'Publish a graph or partition', false),
    artifactCommand('promote', 'Promote a complete graph', true),
  ]),
)
