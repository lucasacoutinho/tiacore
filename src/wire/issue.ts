import * as Cause from 'effect/Cause'
import * as Exit from 'effect/Exit'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import type * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'

const formatLeaf = SchemaIssue.makeFormatterDefault()

interface Located {
  readonly issue: SchemaIssue.Issue
  readonly path: readonly PropertyKey[]
}

function firstLeaf(
  issue: SchemaIssue.Issue,
  path: readonly PropertyKey[],
): Located {
  return Match.value(issue).pipe(
    Match.tag('Pointer', (pointer) =>
      firstLeaf(pointer.issue, [...path, ...pointer.path]),
    ),
    Match.tag('Filter', 'Encoding', (wrapper) =>
      firstLeaf(wrapper.issue, path),
    ),
    Match.tag('Composite', (composite) => firstLeaf(composite.issues[0], path)),
    Match.orElse((leaf) => ({ issue: leaf, path })),
  )
}

function renderPath(path: readonly PropertyKey[]): string {
  return path
    .map((key) => (typeof key === 'number' ? `[${key}]` : `.${String(key)}`))
    .join('')
    .replace(/^\./u, '')
}

/** Renders the first failure of a decode as `subject path: message`. */
export function describeIssue(
  subject: string,
  issue: SchemaIssue.Issue,
): string {
  const { issue: leaf, path } = firstLeaf(issue, [])
  const message = Match.value(leaf).pipe(
    Match.tag('UnexpectedKey', () => 'has an unknown field'),
    Match.tag('MissingKey', () => 'is required'),
    Match.orElse((other) => formatLeaf(other)),
  )
  const location = renderPath(path)
  return location === ''
    ? `${subject} ${message}`
    : `${subject} ${location} ${message}`
}

/**
 * The decoded value, or a thrown `Error` that names `subject` and the first
 * failure. A defect in the decoder itself is rethrown as it is.
 */
export function valueOrThrow<A>(
  subject: string,
  exit: Exit.Exit<A, Schema.SchemaError>,
): A {
  if (Exit.isSuccess(exit)) return exit.value
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error)) throw Cause.squash(exit.cause)
  throw new Error(describeIssue(subject, error.value.issue))
}
