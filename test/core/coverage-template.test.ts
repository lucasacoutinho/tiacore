import type { FileCoverageData } from 'istanbul-lib-coverage'
import { expectTypeOf, test } from 'vitest'

import type { TiaCoverageTemplate } from '../../src/core/runtime.ts'

// The public type is written out so declarations need no Istanbul types; it
// must stay interchangeable with what Istanbul produces and consumes.
test('a coverage template is Istanbul file coverage without its path', () => {
  expectTypeOf<TiaCoverageTemplate>().toEqualTypeOf<
    Omit<FileCoverageData, 'path'>
  >()
})
