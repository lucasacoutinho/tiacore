import picomatch from 'picomatch'

import { matchingFiles } from './files.ts'
import type {
  TiaFrameworkEdgeAdapter,
  TiaSubprocessEdgeOptions,
} from './types.ts'

export function subprocessEdges(
  options: TiaSubprocessEdgeOptions,
): TiaFrameworkEdgeAdapter {
  const mappings = options.mappings.map((mapping) => ({
    files: [...mapping.files].sort(),
    tests: [...mapping.tests].sort(),
  }))

  return {
    fingerprint: JSON.stringify(mappings),
    name: 'subprocess',
    resolve(context) {
      return mappings.flatMap((mapping) =>
        picomatch.isMatch(context.testFile, mapping.tests)
          ? matchingFiles(context.root, mapping.files)
          : [],
      )
    },
  }
}
