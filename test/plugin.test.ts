import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { tia } from '../src/vitest/plugin.js'

interface TestConfig {
  root?: string
  test?: {
    setupFiles?: string | string[]
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
      tagsFilter?: string[]
      testNamePattern?: RegExp
      watch: boolean
    }
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

const temporaryDirectories: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiajs-plugin-'))
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
      /^import "file:\/\/.*\/(?:src|dist)\/vitest\/setup\.(?:js|ts)"\n$/,
    )
  })

  test.each([
    { browser: false, coverage: false, name: 'watch mode', watch: true },
    {
      browser: false,
      coverage: false,
      filters: ['test/example.test.ts'],
      name: 'explicit file filters',
      watch: false,
    },
    {
      browser: false,
      coverage: false,
      name: 'test name filters',
      testNamePattern: /example/,
      watch: false,
    },
  ])('does not inject selection or reporters in $name', (mode) => {
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
          ...('filters' in mode ? { filters: mode.filters } : {}),
          reporters,
          ...(
            'testNamePattern' in mode
              ? { testNamePattern: mode.testNamePattern }
              : {}
          ),
          watch: mode.watch,
        },
        projects: [project],
      },
    }

    instance.configureVitest?.(context)

    expect(context.project.config.include).toBe(include)
    expect(reporters).toEqual([])
  })
})
