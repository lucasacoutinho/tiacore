import { defineConfig, r, use } from '@lucasacoutinho/archer'

const allowed: Record<string, readonly string[]> = {
  assurance: ['core', 'wire', 'host', 'engine', 'runners'],
  cli: ['core', 'wire', 'host', 'engine', 'runners', 'assurance'],
  core: [],
  engine: ['core', 'wire', 'host', 'probe'],
  evidence: [],
  host: ['core', 'wire'],
  probe: ['core'],
  runners: ['core', 'wire', 'host', 'probe', 'engine', 'evidence'],
  wire: ['core'],
}

// The workspace loader imports a user-chosen config module at runtime.
const workspaceLoader = 'src/assurance/workspace/config.ts'

export default defineConfig({
  // A baseline would accept violations silently.
  baseline: false,
  // The package sources only, as the rules below select them.
  projects: ['tsconfig.build.json'],
  rules: [
    r.acyclic('strict/no-cycles', 'src/**'),
    r.resolvable('strict/resolvable-dependencies', {
      all: ['src/**', { not: workspaceLoader }],
    }),
    r.forbidUse('strict/strict-equality', 'src/**', use.looseEquality),
    // A layer may import local files only from itself and the layers listed.
    // Files outside every layer, such as `src/entries`, are not allowed either.
    ...Object.entries(allowed).map(([layer, dependencies]) =>
      r.onlyDependOn(
        `layers/${layer}`,
        `src/${layer}/**`,
        [layer, ...dependencies].map((name) => `src/${name}/**`),
        { localOnly: true },
      ),
    ),
    r.forbid(
      'boundaries/no-entrypoint-backedges',
      { all: ['src/**', { not: ['src/entries/**', workspaceLoader] }] },
      'src/entries/**',
      {
        reason:
          'Package entry points stay thin leaves of the dependency graph.',
      },
    ),
    // At most 799 lines, so every file stays under 800.
    r.maxLines('maintainability/source-size', 'src/**', 799),
  ],
})
