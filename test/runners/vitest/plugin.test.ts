import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import { tia } from '../../../src/runners/vitest/plugin.ts'

interface TestConfig {
  root?: string
  test?: {
    fsModuleCache?: boolean
    setupFiles?: string | string[]
    sharedViteServer?: boolean
  }
}

interface TestPluginContext {
  project: {
    config: {
      browser: { enabled: boolean }
      coverage: { enabled: boolean }
      include: string[]
      root: string
    }
    provide: (key: string, value: unknown) => void
  }
  vitest: {
    config: {
      changed?: boolean | string
      cliExclude?: string[]
      filters?: string[]
      project?: string[]
      reporters: unknown[]
      related?: string[]
      sequence: { hooks: 'list' | 'parallel' | 'stack' }
      tagsFilter?: string[]
      testNamePattern?: RegExp
      watch: boolean
    }
    logger: { log: (message: string) => void }
    projects: TestPluginContext['project'][]
  }
}

interface CallablePlugin {
  config?: (config: TestConfig) => unknown
  configureVitest?: (context: TestPluginContext) => unknown
}

function plugin(): CallablePlugin {
  return tia({ enabled: true }) as unknown as CallablePlugin
}

function ignoreSuitePathInArgv(run: () => void): void {
  const previous = process.argv
  process.argv = ['node', 'vitest', 'run']
  try {
    run()
  } finally {
    process.argv = previous
  }
}

const temporaryDirectories: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-plugin-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('plugin composition and bypasses', () => {
  test('does not touch configuration when explicitly disabled', () => {
    const instance = tia({
      enabled: false,
    }) as unknown as CallablePlugin
    const config: TestConfig = {
      test: { setupFiles: './test/setup.ts' },
    }

    instance.config?.(config)

    expect(config.test?.setupFiles).toBe('./test/setup.ts')
  })

  test('turns off Vitest 5 module caching and shared Vite servers by default', () => {
    const config: TestConfig = { root: temporaryRoot() }

    plugin().config?.(config)

    expect(config.test).toMatchObject({
      fsModuleCache: false,
      sharedViteServer: false,
    })
  })

  test('keeps explicit module cache and shared Vite server settings', () => {
    const config: TestConfig = {
      root: temporaryRoot(),
      test: { fsModuleCache: true, sharedViteServer: true },
    }

    plugin().config?.(config)

    expect(config.test).toMatchObject({
      fsModuleCache: true,
      sharedViteServer: true,
    })
  })

  test('appends its setup module to an existing string setup file', () => {
    const instance = plugin()
    const root = temporaryRoot()
    const config: TestConfig = {
      root,
      test: { setupFiles: './test/setup.ts' },
    }

    instance.config?.(config)

    const setupFiles = config.test?.setupFiles
    expect(setupFiles).toEqual([
      './test/setup.ts',
      expect.stringMatching(/\.tia\/runtime\/setup-.*\.mjs$/),
    ])
    const proxy = setupFiles?.[1]
    expect(typeof proxy === 'string' && existsSync(proxy)).toBe(true)
    expect(readFileSync(proxy!, 'utf8')).toMatch(
      /^import "file:\/\/.*\/(?:src\/runners\/vitest\/setup\.ts|dist\/entries\/vitest-setup\.js)"\n$/,
    )
  })

  test('drops setup files left by an earlier version', () => {
    const root = temporaryRoot()
    const runtime = join(root, '.tia', 'runtime')
    mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, 'setup-1.2.1.mjs'), 'import "old"\n')
    writeFileSync(join(runtime, 'setup-0.4.0.mjs'), 'import "older"\n')
    writeFileSync(join(runtime, 'playwright-session.json'), '{}\n')

    const config: TestConfig = { root }
    const instance = plugin()
    instance.config?.(config)
    instance.config?.(config)

    const setupFiles = config.test?.setupFiles
    const registered = Array.isArray(setupFiles) ? (setupFiles[0] ?? '') : ''
    expect(registered).toMatch(/\.tia\/runtime\/setup-.*\.mjs$/)
    expect(existsSync(registered)).toBe(true)
    expect(readdirSync(runtime).sort()).toEqual(
      ['playwright-session.json', basename(registered)].sort(),
    )
  })

  test.each([
    {
      browser: false,
      coverage: false,
      name: 'watch mode',
      notice: 'tiacore: bypassed, watch mode in use; graph not updated',
      watch: true,
    },
    {
      browser: false,
      coverage: false,
      filters: ['test/example.test.ts'],
      name: 'explicit file filters',
      notice:
        'tiacore: bypassed, native selection (file filters) in use; graph not updated',
      watch: false,
    },
    {
      browser: false,
      coverage: false,
      name: 'test name filters',
      notice:
        'tiacore: bypassed, native selection (-t) in use; graph not updated',
      testNamePattern: /example/,
      watch: false,
    },
    {
      browser: false,
      changed: true,
      coverage: false,
      name: 'the changed filter',
      notice:
        'tiacore: bypassed, native selection (--changed) in use; graph not updated',
      watch: false,
    },
    {
      browser: false,
      coverage: false,
      name: 'the related filter',
      notice:
        'tiacore: bypassed, native selection (--related) in use; graph not updated',
      related: ['src/a.ts'],
      watch: false,
    },
    {
      browser: false,
      coverage: false,
      name: 'a project filter',
      notice:
        'tiacore: bypassed, native selection (--project) in use; graph not updated',
      project: ['unit'],
      watch: false,
    },
    {
      browser: false,
      coverage: false,
      name: 'a tag filter',
      notice:
        'tiacore: bypassed, native selection (--tagsFilter) in use; graph not updated',
      tagsFilter: ['slow'],
      watch: false,
    },
    {
      browser: false,
      cliExclude: ['test/slow.test.ts'],
      coverage: false,
      name: 'a CLI exclude',
      notice:
        'tiacore: bypassed, native selection (--exclude) in use; graph not updated',
      watch: false,
    },
    {
      browser: false,
      cliExclude: ['test/slow.test.ts'],
      coverage: false,
      name: 'watch mode with a CLI exclude',
      notice:
        'tiacore: bypassed, watch mode and native selection (--exclude) in use; graph not updated',
      watch: true,
    },
  ])('does not inject selection or reporters in $name', (mode) => {
    const lines: string[] = []
    const instance = plugin()
    const include = ['test/**/*.test.ts']
    const reporters: unknown[] = []
    const project: TestPluginContext['project'] = {
      config: {
        browser: { enabled: mode.browser },
        coverage: { enabled: mode.coverage },
        include,
        root: process.cwd(),
      },
      provide: () => {},
    }
    const context: TestPluginContext = {
      project,
      vitest: {
        config: {
          ...('changed' in mode ? { changed: mode.changed } : {}),
          ...('cliExclude' in mode ? { cliExclude: mode.cliExclude } : {}),
          ...('filters' in mode ? { filters: mode.filters } : {}),
          ...('project' in mode ? { project: mode.project } : {}),
          ...('related' in mode ? { related: mode.related } : {}),
          reporters,
          sequence: { hooks: 'stack' },
          ...('tagsFilter' in mode ? { tagsFilter: mode.tagsFilter } : {}),
          ...('testNamePattern' in mode
            ? { testNamePattern: mode.testNamePattern }
            : {}),
          watch: mode.watch,
        },
        logger: {
          log: (message) => {
            lines.push(message)
          },
        },
        projects: [project],
      },
    }

    ignoreSuitePathInArgv(() => {
      instance.configureVitest?.(context)
      instance.configureVitest?.(context)
    })

    expect(context.project.config.include).toBe(include)
    expect(reporters).toEqual([])
    expect(lines).toEqual([`\n ${mode.notice}`])
  })

  test('stays quiet when log is off', () => {
    const lines: string[] = []
    const instance = tia({
      enabled: true,
      log: false,
    }) as unknown as CallablePlugin
    const include = ['test/**/*.test.ts']
    const project: TestPluginContext['project'] = {
      config: {
        browser: { enabled: false },
        coverage: { enabled: false },
        include,
        root: process.cwd(),
      },
      provide: () => {},
    }
    const context: TestPluginContext = {
      project,
      vitest: {
        config: {
          cliExclude: ['test/slow.test.ts'],
          reporters: [],
          sequence: { hooks: 'stack' },
          watch: false,
        },
        logger: {
          log: (message) => {
            lines.push(message)
          },
        },
        projects: [project],
      },
    }

    ignoreSuitePathInArgv(() => {
      instance.configureVitest?.(context)
    })

    expect(context.project.config.include).toBe(include)
    expect(lines).toEqual([])
  })
})

describe('the built plugin', () => {
  test('points its setup module at the worker chunk that ships in dist', async () => {
    const built: { tia: typeof tia } = await import(
      pathToFileURL(resolve('dist/entries/vitest.js')).href
    )
    const root = temporaryRoot()
    const config: TestConfig = { root }

    ;(built.tia({ enabled: true }) as unknown as CallablePlugin).config?.(
      config,
    )

    const proxy = config.test?.setupFiles
    expect(proxy).toEqual([
      expect.stringMatching(/\.tia\/runtime\/setup-.*\.mjs$/),
    ])
    const [proxyFile] = [proxy].flat()
    const target = /^import "(.*)"\n$/.exec(
      readFileSync(proxyFile ?? '', 'utf8'),
    )?.[1]
    expect(target).toBeDefined()
    expect(fileURLToPath(target ?? '')).toBe(
      resolve('dist/entries/vitest-setup.js'),
    )
    expect(existsSync(fileURLToPath(target ?? ''))).toBe(true)
  })
})
