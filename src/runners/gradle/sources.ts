import { basename, extname } from 'node:path'

import { byCodeUnit } from '../../core/canonical.ts'

// What a Java or Kotlin file declares and reaches, read with regular
// expressions: enough to link a test class to the files it uses without a
// compiler. Plain TypeScript, since it runs once per file.

/** A Java or Kotlin file as the dependency analysis reads it. */
export interface JvmSource {
  readonly file: string
  readonly imports: readonly string[]
  /**
   * The simple names other files reach this one by: the class 1.x named it
   * after, its top-level types and, in Kotlin, its top-level functions and
   * properties and the class they compile into.
   */
  readonly names: readonly string[]
  /**
   * Whether it declares top-level Kotlin operator functions, which other
   * files use through a symbol (`a + b`, `x[i]`, `by`) rather than a name.
   */
  readonly operators: boolean
  readonly packageName: string
  readonly text: string
}

const PACKAGE = /^\s*package\s+([A-Za-z_][\w.]*)/mu
const FIRST_TYPE =
  /^\s*(?:(?:public|private|protected|internal|abstract|final|open|data|sealed|enum|annotation)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/mu
const IMPORT = /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.*]*)/gmu
const IDENTIFIER = String.raw`[\p{L}_$][\p{L}\p{N}_$]*`
const ANNOTATIONS = String.raw`(?:@[\w.:]+(?:\([^)\n]*\))?\s+)*`
// A top-level declaration starts its line; a nested one is indented. Group 1
// holds the modifiers, group 2 the declared name.
const TOP_LEVEL_TYPE = new RegExp(
  String.raw`^${ANNOTATIONS}((?:(?:public|private|protected|internal|abstract|final|open|data|sealed|non-sealed|static|strictfp|enum|annotation|value|inline|fun|expect|actual)\s+)*)(?:class|interface|enum|record|object|@interface|typealias)\s+(${IDENTIFIER})`,
  'gmu',
)
const KOTLIN_MODIFIERS = String.raw`((?:(?:public|private|internal|inline|suspend|tailrec|operator|infix|external|const|lateinit|expect|actual)\s+)*)`
const KOTLIN_FUNCTION = new RegExp(
  String.raw`^${ANNOTATIONS}${KOTLIN_MODIFIERS}fun\s+[^(\n]*?(${IDENTIFIER})\s*\(`,
  'gmu',
)
const KOTLIN_PROPERTY = new RegExp(
  String.raw`^${ANNOTATIONS}${KOTLIN_MODIFIERS}(?:val|var)\s+(?:<[^>\n]*>\s*)?(?:[^\s:=({]+\.|[^:=({\n]*>\.)?(${IDENTIFIER})`,
  'gmu',
)
const PRIVATE = /(?:^|\s)private\s/u
const OPERATOR = /(?:^|\s)operator\s/u
const JVM_NAME = /^@file:JvmName\("([^"]+)"\)/mu
const WORD = new RegExp(IDENTIFIER, 'gu')

/** The class 1.x named a file by: its first declared type, or its file name. */
function firstType(file: string, text: string): string {
  return FIRST_TYPE.exec(text)?.[1] ?? basename(file, extname(file))
}

function qualified(packageName: string, name: string): string {
  return packageName === '' ? name : `${packageName}.${name}`
}

/** The class Gradle runs a test file as, named the way 1.x named it. */
export function testClassName(file: string, text: string): string {
  return qualified(PACKAGE.exec(text)?.[1] ?? '', firstType(file, text))
}

/**
 * The modifiers and name of each declaration `pattern` finds that other files
 * can see: Kotlin keeps a private top-level declaration inside its file.
 */
function visible(text: string, pattern: RegExp): [string, string][] {
  const found: [string, string][] = []
  for (const [, modifiers = '', name] of text.matchAll(pattern)) {
    const spaced = ` ${modifiers}`
    if (name !== undefined && !PRIVATE.test(spaced)) found.push([spaced, name])
  }
  return found
}

export function parseJvmSource(file: string, text: string): JvmSource {
  const names = new Set([firstType(file, text)])
  for (const [, name] of visible(text, TOP_LEVEL_TYPE)) names.add(name)
  let operators = false
  if (extname(file) === '.kt') {
    names.add(`${basename(file, '.kt')}Kt`)
    const jvmName = JVM_NAME.exec(text)?.[1]
    if (jvmName !== undefined) names.add(jvmName)
    for (const [modifiers, name] of visible(text, KOTLIN_FUNCTION)) {
      names.add(name)
      if (OPERATOR.test(modifiers)) operators = true
    }
    for (const [, name] of visible(text, KOTLIN_PROPERTY)) names.add(name)
  }
  const imports: string[] = []
  for (const match of text.matchAll(IMPORT)) {
    if (match[1] !== undefined) imports.push(match[1])
  }
  return {
    file,
    imports,
    names: [...names],
    operators,
    packageName: PACKAGE.exec(text)?.[1] ?? '',
    text,
  }
}

function add<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key)
  if (values === undefined) map.set(key, [value])
  else values.push(value)
}

/** What one package declares. */
interface PackageDeclarations {
  readonly byName: Map<string, JvmSource[]>
  /** Its files with operator functions, which a file can use without naming. */
  readonly operators: JvmSource[]
}

/**
 * Follows what files reach: their imports, resolved like 1.x by the longest
 * prefix that names a known declaration, and, from their own package and the
 * packages they import whole, the names they mention and every file with
 * operator functions. The function it returns gives every other file a file
 * reaches, directly or through others, sorted.
 */
export function dependencyResolver(
  sources: Iterable<JvmSource>,
): (source: JvmSource) => string[] {
  const byName = new Map<string, JvmSource[]>()
  const byPackage = new Map<string, PackageDeclarations>()
  for (const source of sources) {
    let declared = byPackage.get(source.packageName)
    if (declared === undefined) {
      declared = { byName: new Map(), operators: [] }
      byPackage.set(source.packageName, declared)
    }
    if (source.operators) declared.operators.push(source)
    for (const name of source.names) {
      add(byName, qualified(source.packageName, name), source)
      add(declared.byName, name, source)
    }
  }
  const imported = (name: string): readonly JvmSource[] => {
    const parts = name.split('.')
    while (parts.length > 0) {
      const found = byName.get(parts.join('.'))
      if (found !== undefined) return found
      parts.pop()
    }
    return []
  }
  const reached = new Map<JvmSource, ReadonlySet<JvmSource>>()
  const direct = (source: JvmSource): ReadonlySet<JvmSource> => {
    const known = reached.get(source)
    if (known !== undefined) return known
    const found = new Set<JvmSource>()
    const scopes = new Set<PackageDeclarations>()
    const own = byPackage.get(source.packageName)
    if (own !== undefined) scopes.add(own)
    for (const name of source.imports) {
      const whole = name.endsWith('.*')
      const target = whole ? name.slice(0, -2) : name
      for (const file of imported(target)) found.add(file)
      const members = whole ? byPackage.get(target) : undefined
      if (members !== undefined) scopes.add(members)
    }
    for (const scope of scopes) {
      for (const file of scope.operators) found.add(file)
    }
    for (const [word] of source.text.matchAll(WORD)) {
      for (const scope of scopes) {
        for (const file of scope.byName.get(word) ?? []) found.add(file)
      }
    }
    found.delete(source)
    reached.set(source, found)
    return found
  }
  return (start) => {
    const seen = new Set<JvmSource>([start])
    const pending = [start]
    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined) continue
      for (const file of direct(next)) {
        if (seen.has(file)) continue
        seen.add(file)
        pending.push(file)
      }
    }
    seen.delete(start)
    return [...seen].map((source) => source.file).sort(byCodeUnit)
  }
}
