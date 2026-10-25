import * as Cause from 'effect/Cause'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'

import type {
  TiaWorkspaceLaneRunner,
  TiaWorkspaceOptions,
} from '../../core/workspace.ts'
import { describeIssue } from '../../wire/issue.ts'

// A runner is anything with a run() method, decided structurally so a runner
// built by another copy of tiacore (or any adapter package) is accepted.
const isRunner = (value: unknown): value is TiaWorkspaceLaneRunner =>
  Predicate.hasProperty(value, 'run') && Predicate.isFunction(value.run)

const Runner = Schema.declare(isRunner, {
  expected: 'an object with a run() method',
})

const Strings = Schema.mutable(Schema.Array(Schema.String))

const Lane = Schema.Struct({
  arguments: Schema.optionalKey(Strings),
  command: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  dependsOn: Schema.optionalKey(Strings),
  environment: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String)),
  ),
  id: Schema.String,
  resourceLocks: Schema.optionalKey(Strings),
  runner: Schema.optionalKey(Runner),
})

/**
 * The workspace configuration. `concurrency` must be a finite number: NaN and
 * Infinity are rejected here instead of silently lifting the bound (ADR 0004,
 * NODE-PAR-03 / WS-SCHED-01).
 */
export const WorkspaceOptions = Schema.Struct({
  concurrency: Schema.optionalKey(Schema.Finite),
  failFast: Schema.optionalKey(Schema.Boolean),
  lanes: Schema.mutable(Schema.Array(Lane)),
  root: Schema.optionalKey(Schema.String),
})

const decode = Schema.decodeUnknownExit(WorkspaceOptions)

/** Decodes a workspace configuration, keeping runner objects by reference. */
export function decodeWorkspaceOptions(value: unknown): TiaWorkspaceOptions {
  const exit = decode(value)
  if (Exit.isSuccess(exit)) return exit.value
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error)) throw Cause.squash(exit.cause)
  throw new Error(describeIssue('TIA workspace options', error.value.issue))
}
