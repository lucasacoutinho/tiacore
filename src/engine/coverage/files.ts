import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import coverageLibrary from 'istanbul-lib-coverage'
import { createInstrumenter } from 'istanbul-lib-instrument'
import picomatch from 'picomatch'
import { globSync } from 'tinyglobby'

import { errorMessage } from '../../wire/errors.ts'
import { slash } from '../host-path.ts'
import type { TiaCoverageMap, TiaCoverageRuntime } from './types.ts'

interface SelectedCoverage {
  coverage: ReturnType<typeof coverageLibrary.createCoverageMap>
  warnings: string[]
}

function matcher(patterns: string[]): picomatch.Matcher | null {
  return patterns.length === 0
    ? null
    : picomatch(patterns, { contains: true, dot: true })
}

function matches(
  file: string,
  root: string,
  value: picomatch.Matcher | null,
): boolean {
  if (value === null) {
    return false
  }

  const absolute = slash(resolve(file))
  const relative = slash(absolute.slice(slash(resolve(root)).length + 1))
  return value(absolute) || value(relative)
}

function zeroCoverage(file: string): TiaCoverageMap[string] {
  const instrumenter = createInstrumenter({
    coverageVariable: '__coverage__',
    esModules: true,
    parserPlugins: ['typescript', 'jsx'],
    produceSourceMap: true,
  })
  instrumenter.instrumentSync(readFileSync(file, 'utf8'), file)
  return instrumenter.lastFileCoverage()
}

export function selectedCoverage(
  coverage: ReturnType<typeof coverageLibrary.createCoverageMap>,
  root: string,
  options: TiaCoverageRuntime,
): SelectedCoverage {
  const selected = coverageLibrary.createCoverageMap(coverage.toJSON())
  const includes = matcher(options.include ?? [])
  const excludes = matcher(options.exclude)
  const warnings: string[] = []

  selected.filter(
    (file) =>
      existsSync(file) &&
      (options.include === null || matches(file, root, includes)) &&
      !matches(file, root, excludes),
  )

  if (options.include === null) {
    return { coverage: selected, warnings }
  }

  const files = globSync(options.include, {
    absolute: true,
    cwd: root,
    dot: true,
    followSymbolicLinks: false,
    ignore: options.exclude,
    onlyFiles: true,
  })

  for (const file of files) {
    const absolute = resolve(file)
    if (
      selected.data[absolute] !== undefined ||
      !matches(absolute, root, includes) ||
      matches(absolute, root, excludes)
    ) {
      continue
    }

    try {
      selected.addFileCoverage(zeroCoverage(absolute))
    } catch (error) {
      warnings.push(
        `TIA coverage could not include ${slash(absolute)}: ${errorMessage(error)}`,
      )
    }
  }

  return { coverage: selected, warnings }
}
