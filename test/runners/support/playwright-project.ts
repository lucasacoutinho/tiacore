import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { chromium } from 'playwright'

import type { TiaRuntimeGraph } from '../../../src/core/runtime.ts'
import { GraphStore } from '../../../src/engine/ports.ts'
import { GraphStoreLive } from '../../../src/engine/state/graph-store.ts'
import { commit, init } from '../../engine/support/repos.ts'

export const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
)

/** True when Playwright's Chromium is installed, so browser tests can run. */
export function chromiumInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

export const CHROMIUM_MISSING =
  'Chromium is not installed (run `npx playwright install chromium`)'

const directories: string[] = []

export function cleanupProjects(): void {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
}

/** Copies a fixture, links the packages it imports, and commits a baseline. */
export function fixtureProject(name: string): string {
  const source = resolve(packageRoot, 'test/fixtures', name)
  const root = realpathSync(mkdtempSync(join(tmpdir(), `tiacore-${name}-`)))
  directories.push(root)
  cpSync(source, root, { recursive: true })
  mkdirSync(join(root, 'node_modules'))
  for (const dependency of ['@playwright', 'playwright']) {
    const destination = join(root, 'node_modules', dependency)
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(join(packageRoot, 'node_modules', dependency), destination)
  }
  const own = join(root, 'node_modules/@lucasacoutinho/tiacore')
  mkdirSync(dirname(own), { recursive: true })
  symlinkSync(packageRoot, own)
  init(root)
  commit(root, 'baseline')
  return root
}

export interface CommandResult {
  output: string
  status: number | null
}

export function runNode(
  root: string,
  args: string[],
  environment: Record<string, string> = {},
  timeout = 60_000,
): CommandResult {
  const inherited = { ...process.env }
  delete inherited['TIA']
  delete inherited['TIA_FRESH']
  delete inherited['TIA_PLAYWRIGHT_ROOT']
  delete inherited['TIA_PLAYWRIGHT_SESSION']
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...inherited, ...environment, NO_COLOR: '1' },
    timeout,
  })
  return {
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    status: result.status,
  }
}

const runtime = ManagedRuntime.make(
  Layer.mergeAll(GraphStoreLive).pipe(Layer.provideMerge(NodeServices.layer)),
)

/** The graph a lane stored under `<root>/.tia/<lane>`, or null. */
export async function storedGraph(
  root: string,
  lane = 'playwright',
): Promise<TiaRuntimeGraph | null> {
  const stored = await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* GraphStore
      return yield* store.read(join(root, '.tia', lane))
    }),
  )
  return stored.graph
}

export function disposeGraphReader(): Promise<void> {
  return runtime.dispose()
}
