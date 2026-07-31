import { readFile, writeFile } from 'node:fs/promises'

import type { TiaChangeSet, TiaSuiteDescriptor } from '../protocol/types.js'

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

export async function emit(
  value: unknown,
  output: string | undefined,
): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  if (output === undefined || output === '-') {
    process.stdout.write(serialized)
    return
  }
  await writeFile(output, serialized, 'utf8')
}

export function parseCatalog(value: unknown): TiaSuiteDescriptor[] {
  if (!Array.isArray(value)) {
    throw new Error('TIA suite catalog must be an array')
  }
  return value as TiaSuiteDescriptor[]
}

export function parseChanges(value: unknown): TiaChangeSet {
  if (Array.isArray(value) && value.every((file) => typeof file === 'string')) {
    return { files: value }
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { files?: unknown }).files) &&
    (value as { files: unknown[] }).files.every(
      (file) => typeof file === 'string',
    )
  ) {
    return value as TiaChangeSet
  }
  throw new Error(
    'TIA change set must be a string array or an object with files',
  )
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}
