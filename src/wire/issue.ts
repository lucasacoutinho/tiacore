import * as Match from 'effect/Match'
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
