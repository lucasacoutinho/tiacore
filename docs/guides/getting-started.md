# Getting started

tiacore adapters all expose `tia()`, but they integrate at the boundary native
to each runner. Start with one runner, record a full baseline, then run the same
command again to verify replay before adding CI restoration.

## Requirements

- The npm package requires Node.js 20 or newer.
- Vitest requires version 4.1 or newer.
- The standalone `node:test` adapter requires Node.js 22.10 or newer. Node 22.15
  and newer provides precise non-executing discovery.
- Playwright requires version 1.46 or newer.
- The Bun adapter is certified on Bun 1.3.

## Install

Until private packages are published, install a local checkout or an exact VCS
revision:

```sh
npm install --save-dev ../tiacore
npm install --save-dev \
  git+ssh://git@github.com/usescherie/tiacore.git#<exact-commit>
```

VCS installations compile during `prepare`; generated `dist/` files are not
committed. Bun VCS consumers must list `@usescherie/tiacore` in the root
`trustedDependencies` and have npm available for the temporary, lockfile-pinned
build toolchain.

Add `.tia/` to `.gitignore`. Packed, linked, workspace, and VCS installations
provide both ESM and CommonJS exports.

## Vitest

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { tia } from '@usescherie/tiacore/vitest'

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

The root `@usescherie/tiacore` export remains a compatibility alias, but new
configs should use `/vitest`. Watch mode and explicit Vitest file, project,
name, related-file, changed-file, tag, or exclusion filters remain native Vitest
operations and do not replace the reusable full-suite graph.

## Playwright

Wrap the test fixture once:

```ts
// e2e/fixture.ts
import { expect, test as base } from '@playwright/test'
import { tia } from '@usescherie/tiacore/playwright'

export const test = tia(base)
export { expect }
```

Append the reporter without removing existing reporters:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'
import { tia } from '@usescherie/tiacore/playwright'

export default defineConfig({
  reporter: [['line'], ['html', { open: 'never' }], tia()],
  testDir: './e2e',
})
```

Run through the adapter:

```ts
// e2e/run-tia.ts
import { tia } from '@usescherie/tiacore/playwright'

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
import { tia } from '@usescherie/tiacore/node'

const result = await tia({
  concurrency: 4,
  files: ['test/**/*.test.mjs'],
}).run()

process.exitCode = result.success ? 0 : 1
```

Use `node run-tia.mjs`. For Bun, change the import to `@usescherie/tiacore/bun`,
use Bun test globs, and run `bun run-tia.ts`. Files execute concurrently up to
the configured bound; cases within one file stay sequential.

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
declares a performance-host lock.

## pytest

The dependency-free Python SDK lives in [`sdks/python`](../../sdks/python). It
discovers pytest files, local imports, and `conftest.py` dependencies, executes
selected files, and writes a protocol-v1 graph. It is a static-impact adapter
and does not claim runtime coverage or cached pytest outcomes.

## Workspace orchestration

Use the workspace adapter to run independent lanes concurrently while preserving
dependencies and exclusive resources:

```js
// tiacore.config.mjs
import { tia } from '@usescherie/tiacore/workspace'

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
