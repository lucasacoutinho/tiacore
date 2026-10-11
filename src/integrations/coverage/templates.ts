import type { FileCoverageData } from 'istanbul-lib-coverage'

import { projectRelative } from '../../shared/paths.js'
import type {
  TiaCoverageCounterMap,
  TiaCoverageMap,
  TiaCoverageTemplate,
} from './types.js'

// Istanbul prepends a coverage function that declares the file's hash before
// any program code, so the first declaration is the instrumentation's own.
const INSTRUMENTATION_HASH = /\bvar hash\s*=\s*"([0-9a-f]+)"/

export function instrumentationHash(instrumentedCode: string): string | null {
  return INSTRUMENTATION_HASH.exec(instrumentedCode)?.[1] ?? null
}

/**
 * Holds one copy of each instrumented file's static coverage maps so per-test
 * coverage can travel and stay in memory as advanced counters only.
 */
export class CoverageTemplates {
  private readonly templates = new Map<string, TiaCoverageTemplate>()

  get size(): number {
    return this.templates.size
  }

  register(instrumentedCode: string, coverage: FileCoverageData): void {
    const hash = instrumentationHash(instrumentedCode)
    if (hash === null || this.templates.has(hash)) {
      return
    }

    this.templates.set(hash, {
      b: coverage.b,
      branchMap: coverage.branchMap,
      f: coverage.f,
      fnMap: coverage.fnMap,
      s: coverage.s,
      statementMap: coverage.statementMap,
    })
  }

  /** Lists project files whose counters have no registered template. */
  unknownFiles(root: string, counters: TiaCoverageCounterMap): string[] {
    return Object.entries(counters)
      .filter(
        ([path, file]) =>
          !this.templates.has(file.hash) &&
          (projectRelative(root, path) ?? '') !== '',
      )
      .map(([path]) => path)
  }

  /**
   * Rebuilds project-relative Istanbul file coverage from advanced counters.
   * Files share their template's static maps instead of copying them.
   */
  expand(root: string, counters: TiaCoverageCounterMap): TiaCoverageMap {
    const coverage: TiaCoverageMap = {}

    for (const [key, file] of Object.entries(counters)) {
      const template = this.templates.get(file.hash)
      const path = projectRelative(root, key)
      if (template === undefined || path === null || path === '') {
        continue
      }

      const b: Record<string, number[]> = {}
      for (const [branch, zeros] of Object.entries(template.b)) {
        b[branch] = [...zeros]
      }
      coverage[path] = {
        b: Object.assign(b, file.b),
        branchMap: template.branchMap,
        f: { ...template.f, ...file.f },
        fnMap: template.fnMap,
        path,
        s: { ...template.s, ...file.s },
        statementMap: template.statementMap,
      }
    }

    return coverage
  }
}
