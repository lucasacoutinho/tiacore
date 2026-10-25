import type { FileCoverageData } from 'istanbul-lib-coverage'

import type {
  TiaCoverageRecord,
  TiaCoverageTemplate,
} from '../../core/runtime.ts'
import type { ProbeCounterMap } from '../../probe/types.ts'
import { projectRelative } from '../project-relative.ts'
import { coverageMapId, coverageTemplate } from '../state/coverage.ts'

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
  private readonly byHash = new Map<string, string>()
  private readonly byId = new Map<string, TiaCoverageTemplate>()

  register(instrumentedCode: string, coverage: FileCoverageData): void {
    const hash = instrumentationHash(instrumentedCode)
    if (hash === null || this.byHash.has(hash)) {
      return
    }

    const template = coverageTemplate(coverage)
    const id = coverageMapId(template)
    this.byHash.set(hash, id)
    if (!this.byId.has(id)) {
      this.byId.set(id, template)
    }
  }

  /** Lists project files whose counters have no registered template. */
  unknownFiles(root: string, counters: ProbeCounterMap): string[] {
    return Object.entries(counters)
      .filter(
        ([path, file]) =>
          !this.byHash.has(file.hash) &&
          (projectRelative(root, path) ?? '') !== '',
      )
      .map(([path]) => path)
  }

  /** Converts worker counters into a project-relative graph record. */
  record(root: string, counters: ProbeCounterMap): TiaCoverageRecord {
    const record: TiaCoverageRecord = {}

    for (const [key, file] of Object.entries(counters)) {
      const map = this.byHash.get(file.hash)
      const path = projectRelative(root, key)
      if (map === undefined || path === null || path === '') {
        continue
      }
      record[path] = { b: file.b, f: file.f, map, s: file.s }
    }

    return record
  }

  /** Returns the templates that the given records name. */
  maps(
    records: Iterable<TiaCoverageRecord>,
  ): Record<string, TiaCoverageTemplate> {
    const maps: Record<string, TiaCoverageTemplate> = {}
    for (const record of records) {
      for (const hits of Object.values(record)) {
        const template = this.byId.get(hits.map)
        if (template !== undefined) {
          maps[hits.map] = template
        }
      }
    }
    return maps
  }
}
