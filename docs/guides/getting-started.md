# Getting started

tiacore adapters all expose `tia()`, but they integrate at the boundary native
to each runner. Start with one runner, record a full baseline, then run the same
command again to verify replay before adding CI restoration.

## Requirements

- The npm package requires Node.js `^22.12.0 || >=24.0.0`. It is ESM only. From
  CommonJS, use `require()` on Node.js 22.12 or newer.
- Vitest requires version 4.1 or 5.
- The standalone `node:test` adapter gets precise non-executing discovery on
  Node.js 22.15 and newer.
- Playwright requires version 1.46 or newer.
- The Bun adapter is certified on Bun 1.3.
- The Vitest plugin under Bun (`bunx --bun vitest run`) is best-effort: it
  records and replays, and `@effect/vitest` fiber attribution needs Node.js.

## Install

Install the package from npm:

```sh
npm install -D @lucasacoutinho/tiacore
```

To test unreleased changes, install from Git. The package manager installs
tiacore's development dependencies and its `prepare` script builds `dist/`:

```sh
npm install -D github:lucasacoutinho/tiacore#<commit>
```

Bun does not install a Git dependency's development dependencies, so `prepare`
installs the pinned build toolchain with npm, builds, and removes it. Bun runs
the `prepare` script only for packages listed in `trustedDependencies`.

You can also build a checkout and install the tarball it packs:

```sh
npm ci
npm pack
npm install --save-dev /path/to/tiacore/lucasacoutinho-tiacore-<version>.tgz
```

Add `.tia/` to `.gitignore`.

## Vitest

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { tia } from '@lucasacoutinho/tiacore/vitest'

export default defineConfig({
  plugins: [tia()],
  test: {
    include: ['src/**/*.test.ts'],
  },
})
```

Run the existing command:

```sh
npx vitest run
```

The root `@lucasacoutinho/tiacore` export remains a compatibility alias, but new
configs should use `/vitest`. Watch mode and explicit Vitest file, project,
name, related-file, changed-file, tag, or exclusion filters remain native Vitest
operations and do not replace the reusable full-suite graph. Tiacore prints one
line that names the bypass, such as
`tiacore: bypassed, native selection (--exclude) in use; graph not updated`, and
leaves the graph unchanged. `log: false` hides the line.

### Testing with `@effect/vitest`

The plugin needs no extra setup. Tiacore attributes coverage to the test whose
body is running, so `it.effect`, `it.live`, scoped resources, `it.prop` and
`it.effect.prop` select exact test cases. Code that runs outside a body belongs
to the whole file: a layer's construction and finalizers, and a fiber that
finishes between tests. A `layer(L, { concurrent: true })` block selects its
whole file.

A detached fiber (`Effect.forkDetach`) can outlive the test that forked it and
finish while a later test runs. The later test did not start that work, so
tiacore does not charge it to that test. The modules the fiber touches become
evidence of the whole file, like a fiber that finishes between tests: editing
one of them selects every test of the file, and `tiacore verify` agrees between
its selective and full phases. What the later test calls itself stays in its own
window. To keep per-test selection for those modules, finish or interrupt fibers
before the test body ends.

Tiacore finds the test that started a fiber through the async context that
Effect 4 keeps for each fiber, so this works on Node.js only. A fiber that no
test started, such as one a layer forks in a `beforeAll` hook, is charged to the
test that is running when it executes. Work that is not an Effect fiber, such as
a timer callback, is charged the same way (see
[Known limits](../migration/1.x-to-2.0.md#known-limits)). Tiacore separates the
first 1,000 steps of such fibers in a test file and charges later steps to the
running test, because separating a step costs two passes over every coverage
counter.

## Playwright

Wrap the test fixture once:

```ts
// e2e/fixture.ts
import { expect, test as base } from '@playwright/test'
import { tia } from '@lucasacoutinho/tiacore/playwright'

export const test = tia(base)
export { expect }
```

Append the reporter without removing existing reporters:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'
import { tia } from '@lucasacoutinho/tiacore/playwright'

export default defineConfig({
  reporter: [['line'], ['html', { open: 'never' }], tia()],
  testDir: './e2e',
})
```

Run through the adapter:

```ts
// e2e/run-tia.ts
import { tia } from '@lucasacoutinho/tiacore/playwright'

const result = await tia({
  config: 'playwright.config.ts',
  name: 'qa',
  root: process.cwd(),
}).run(process.argv.slice(2))

process.exitCode = result.success ? 0 : 1
```

Chromium traces executed ranges through source maps. Other browsers use the
conservative source-map file list. Later runs preserve Playwright workers,
projects, retries, and dependencies. A no-change replay does not launch the
configured web servers.

## Node and Bun

Existing tests continue importing their native APIs. Create one runner file:

```js
// run-tia.mjs
import { tia } from '@lucasacoutinho/tiacore/node'

const result = await tia({
  concurrency: 4,
  files: ['test/**/*.test.mjs'],
}).run()

process.exitCode = result.success ? 0 : 1
```

Use `node run-tia.mjs`. For Bun, change the import to
`@lucasacoutinho/tiacore/bun`, use Bun test globs, and run `bun run-tia.ts`.
Files execute concurrently up to the configured bound; cases within one file
stay sequential.

## Maestro and k6

Both adapters discover real suites without a hand-written manifest:

```sh
tiacore maestro record \
  --root . --flows apps/mobile/e2e --project mobile \
  --environment-fingerprint android-35 --output .tia/maestro.json

tiacore k6 record \
  --root . --profiles infra/load-testing/k6/profiles --project api \
  --environment-fingerprint k6-container --output .tia/k6.json
```

Their `tia(options).run()` APIs execute selected flows or profiles and promote
the graph only after success. Maestro declares a device resource lock; k6
declares a performance-host lock. `TIA_FRESH=1` plans every flow or profile, as
it does in every other runner.

To compare a selective run of such a script with a fresh full run, put it behind
`tiacore verify`, as in `tiacore verify -- node scripts/run-k6.mjs`. See
[Differential verification](verification.md#suite-granular-runners).

## pytest

The dependency-free Python SDK lives in [`sdks/python`](../../sdks/python). It
discovers pytest files, local imports, and `conftest.py` dependencies, executes
selected files, and writes a protocol-v1 graph. It is a static-impact adapter
and does not claim runtime coverage or cached pytest outcomes.

## Jest

Jest is not supported. tiacore ships no Jest adapter. A `jest` or `jest-expo`
suite stays outside the runners on this page.

A custom adapter through `@lucasacoutinho/tiacore/adapter` is the supported
boundary for a JavaScript or TypeScript runner that records runtime test cases
and cached outcomes. See the [TypeScript adapter contract](custom-adapters.md).
With no adapter, run Jest outside tiacore. A workspace lane that invokes Jest
schedules that command and leaves selection to Jest.

## Workspace orchestration

Use the workspace adapter to run independent lanes concurrently while preserving
dependencies and exclusive resources:

```js
// tiacore.config.mjs
import { tia } from '@lucasacoutinho/tiacore/workspace'

export default tia({
  concurrency: 4,
  lanes: [
    { id: 'unit', command: 'npm', arguments: ['run', 'test:unit'] },
    { id: 'types', command: 'npm', arguments: ['run', 'typecheck'] },
    {
      id: 'mobile-qa',
      command: 'npm',
      arguments: ['run', 'test:mobile'],
      dependsOn: ['types'],
      resourceLocks: ['android-emulator'],
    },
  ],
})
```

Run `tiacore run --config tiacore.config.mjs`. A lane may contain a command or
another adapter runner. The coordinator owns scheduling, not impact selection.

## Rebuild a baseline

Use `TIA_FRESH=1` when you intentionally need a full run and a replacement
graph:

```sh
TIA_FRESH=1 npm test
```

Use `TIA=0` to bypass tiacore entirely. This does not update the graph.
