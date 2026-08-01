export default {
  include: ['src/**/*.ts', 'src/**/*.cts'],
  rules(archer) {
    archer.expect('src/**').toBeFreeOfCycles().as('strict/no-cycles')
    archer
      .expect('src/**')
      .ignoring('src/orchestration/workspace/config.ts')
      .toHaveResolvableDependencies()
      .as('strict/resolvable-dependencies')
      .because(
        'The workspace config loader intentionally imports a path discovered at runtime.',
      )
    archer.expect('src/**').toUseStrictEquality().as('strict/strict-equality')

    const layers = archer.layers({
      adapterContract: 'src/adapter/**',
      adapters: 'src/adapters/**',
      cli: 'src/cli/**',
      conformance: 'src/conformance/**',
      engine: 'src/engine/**',
      entries: 'src/entries/**',
      integrations: 'src/integrations/**',
      orchestration: 'src/orchestration/**',
      protocol: 'src/protocol/**',
      public: 'src/public/**',
      shared: ['src/shared/constants.ts', 'src/shared/paths.ts'],
      verification: 'src/verification/**',
    })

    layers.where('protocol').mayOnlyDependOn()
    layers.where('shared').mayOnlyDependOn()
    layers.where('adapterContract').mayOnlyDependOn('engine', 'protocol')
    layers.where('integrations').mayOnlyDependOn('engine', 'shared')
    layers.where('orchestration').mayOnlyDependOn('engine')
    layers.where('verification').mayOnlyDependOn('engine', 'shared')
    layers.where('public').mayOnlyDependOn('engine', 'integrations')

    layers
      .where('engine')
      .mayNotDependOn(
        'adapterContract',
        'adapters',
        'conformance',
        'entries',
        'orchestration',
        'public',
      )
    layers
      .where('adapters')
      .mayNotDependOn('entries', 'orchestration', 'public')

    archer
      .expect('src/**')
      .ignoring(
        'src/index.ts',
        'src/entries/**',
        'src/orchestration/workspace/config.ts',
      )
      .not.toDependOn(['src/index.ts', 'src/entries/**'])
      .as('boundaries/no-entrypoint-backedges')
      .because(
        'Package entry points must remain thin leaves of the dependency graph.',
      )

    archer
      .expect('src/index.ts')
      .toBePublicApi()
      .as('public/default-entrypoint')
    archer
      .expect('src/**')
      .toHaveLineCountLessThan(800)
      .as('maintainability/source-size')
  },
}
