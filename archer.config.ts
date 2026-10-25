import { existsSync } from 'node:fs'

import { defineConfig } from '@lucasacoutinho/archer'

const allowed: Record<string, readonly string[]> = {
  assurance: ['core', 'wire', 'host', 'engine', 'runners'],
  cli: ['core', 'wire', 'host', 'engine', 'runners', 'assurance'],
  core: [],
  engine: ['core', 'wire', 'host', 'probe'],
  evidence: [],
  host: ['core', 'wire'],
  probe: ['core'],
  runners: ['core', 'wire', 'host', 'probe', 'engine'],
  wire: ['core'],
}
const present = Object.keys(allowed).filter((layer) =>
  existsSync(`src/${layer}`),
)

export default defineConfig({
  include: ['src/**/*.ts'],
  rules(archer) {
    archer.expect('src/**').toBeFreeOfCycles().as('strict/no-cycles')
    archer
      .expect('src/**')
      .toHaveResolvableDependencies()
      .as('strict/resolvable-dependencies')
    archer.expect('src/**').toUseStrictEquality().as('strict/strict-equality')

    const layers = archer.layers(
      Object.fromEntries(present.map((layer) => [layer, `src/${layer}/**`])),
    )
    for (const layer of present) {
      layers
        .where(layer)
        .mayOnlyDependOn(
          ...(allowed[layer] ?? []).filter((dependency) =>
            present.includes(dependency),
          ),
        )
    }

    archer
      .expect('src/**')
      .ignoring('src/entries/**')
      .not.toDependOn(['src/entries/**'])
      .as('boundaries/no-entrypoint-backedges')
      .because('Package entry points stay thin leaves of the dependency graph.')

    archer
      .expect('src/**')
      .toHaveLineCountLessThan(800)
      .as('maintainability/source-size')
  },
})
