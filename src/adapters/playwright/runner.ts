import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import {
  basename,
  relative,
  resolve,
} from 'node:path'

import { TiaCore } from '../../engine/run.js'
import { formatRunPlanDetails } from '../../engine/explain.js'
import {
  frameworkAdapters,
  frameworkFingerprint,
} from '../../integrations/edges/index.js'
import { resolveFrameworkEdges } from '../../integrations/edges/resolve.js'
import type {
  TiaArtifactSource,
  TiaFrameworkOptions,
  RunPlan,
} from '../../shared/types.js'
import { slash } from '../../shared/paths.js'
import {
  importedFilesFingerprint,
  importedProjectFiles,
} from './imports.js'
import {
  PLAYWRIGHT_ROOT_ENV,
  PLAYWRIGHT_SESSION_ENV,
  type PlaywrightRunReport,
} from './protocol.js'

export interface TiaPlaywrightOptions {
  artifacts?: TiaArtifactSource | TiaArtifactSource[]
  cacheDir?: string
  config?: string
  cwd?: string
  fresh?: boolean
  frameworks?: TiaFrameworkOptions
  ignoreChanges?: string[]
  log?: boolean
  name?: string
  onUnknownChange?: 'full' | 'ignore'
  root?: string
}

export interface TiaPlaywrightResult {
  plan: RunPlan
  status: number
  success: boolean
}

function runnerName(config: string): string {
  const configName = basename(config)
    .replace(/\.[cm]?[jt]s$/, '')
    .replace(/^playwright(?:\.|$)/, '')
  const stem = (configName === 'config' ? '' : configName)
    .replace(/\.config$/, '')
    .replace(/[^a-z\d]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return stem === '' ? 'playwright' : `playwright-${stem}`
}

function configuredRunnerName(
  config: string,
  name: string | undefined,
): string {
  if (name === undefined) {
    return runnerName(config)
  }

  const stem = name
    .replace(/[^a-z\d]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  if (stem === '') {
    throw new Error('Playwright TIA name must contain a letter or number.')
  }
  return stem.startsWith('playwright-') || stem === 'playwright'
    ? stem
    : `playwright-${stem}`
}

function playwrightCli(cwd: string): string {
  return createRequire(resolve(cwd, 'package.json')).resolve(
    '@playwright/test/cli',
  )
}

function nodeExecutable(): string {
  const npmNode = process.env.npm_node_execpath
  return npmNode !== undefined && /(?:^|[\\/])node(?:\.exe)?$/i.test(npmNode)
    ? npmNode
    : 'node'
}

function pathFilter(file: string): string {
  return file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function childStatus(
  command: string,
  arguments_: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolveStatus(code ?? (signal === null ? 1 : 128))
    })
  })
}

function readReport(path: string): PlaywrightRunReport | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PlaywrightRunReport
  } catch {
    return null
  }
}

function completeReport(report: PlaywrightRunReport): boolean {
  const observed = new Set(
    report.observations.map((observation) =>
      observation.id.replace(/^playwright:/, ''),
    ),
  )
  return (
    report.status !== 'interrupted' &&
    report.status !== 'timedout' &&
    report.observations.every(
      (observation) => observation.dependenciesComplete,
    ) &&
    report.configuredTestIds.every((id) => observed.has(id))
  )
}

function logPlan(plan: RunPlan): void {
  if (plan.mode === 'record') {
    console.log(`TIA record: ${plan.reason}.`)
    for (const line of formatRunPlanDetails(plan)) {
      console.log(line)
    }
    return
  }
  console.log(
    `TIA replay: ${plan.affectedTests.length} affected file${
      plan.affectedTests.length === 1 ? '' : 's'
    }, ${plan.replayedTests} cached test${
      plan.replayedTests === 1 ? '' : 's'
    }.`,
  )
  for (const line of formatRunPlanDetails(plan)) {
    console.log(line)
  }
}

export class TiaPlaywrightRunner {
  private readonly options: TiaPlaywrightOptions

  constructor(options: TiaPlaywrightOptions) {
    this.options = options
  }

  async run(arguments_: string[] = []): Promise<TiaPlaywrightResult> {
    const root = resolve(this.options.root ?? process.cwd())
    const cwd = resolve(root, this.options.cwd ?? '.')
    const config = resolve(cwd, this.options.config ?? 'playwright.config.ts')
    const runner = configuredRunnerName(config, this.options.name)
    const cacheDir = resolve(root, this.options.cacheDir ?? '.tia')
    const configFingerprint = importedFilesFingerprint(config, root)
    const adapters = frameworkAdapters(this.options.frameworks)
    const runnerFingerprint = createHash('sha256')
      .update(configFingerprint)
      .update(frameworkFingerprint(adapters))
      .digest('hex')
    const core = new TiaCore({
      ...(this.options.artifacts === undefined
        ? {}
        : { artifacts: this.options.artifacts }),
      cacheDir,
      files: [slash(relative(root, config)), ...arguments_],
      fingerprint: runnerFingerprint,
      fresh:
        this.options.fresh ??
        process.env.TIA_FRESH === '1',
      ...(this.options.ignoreChanges === undefined
        ? {}
        : { ignoreChanges: this.options.ignoreChanges }),
      ...(this.options.log === undefined
        ? {}
        : { log: this.options.log }),
      ...(this.options.onUnknownChange === undefined
        ? {}
        : { onUnknownChange: this.options.onUnknownChange }),
      root,
      runner,
    })
    const plan = await core.prepare()
    if (this.options.log ?? true) {
      logPlan(plan)
    }

    if (plan.mode === 'replay' && plan.affectedTests.length === 0) {
      await core.commit([], [])
      return { plan, status: 0, success: true }
    }

    const runtimeDirectory = resolve(cacheDir, 'runtime')
    mkdirSync(runtimeDirectory, { recursive: true })
    const session = resolve(
      runtimeDirectory,
      `${runner}-${process.pid}-${randomUUID()}.json`,
    )
    const affected =
      plan.mode === 'record'
        ? []
        : plan.affectedTests.map((file) =>
            pathFilter(resolve(root, file)),
          )
    const filters =
      affected.join('').length > 24_000 ? [] : affected

    try {
      const cliArguments = [
        playwrightCli(cwd),
        'test',
        '--config',
        config,
        ...arguments_,
        ...filters,
      ]
      const status = await childStatus(
        nodeExecutable(),
        cliArguments,
        cwd,
        {
          ...process.env,
          [PLAYWRIGHT_ROOT_ENV]: root,
          [PLAYWRIGHT_SESSION_ENV]: session,
        },
      )
      const report = readReport(session)
      if (report === null || !completeReport(report)) {
        if (this.options.log ?? true) {
          console.warn(
            'TIA graph was not updated because Playwright dependency evidence was incomplete.',
          )
        }
        return { plan, status, success: status === 0 }
      }

      let frameworkEvidenceComplete = true
      const observations = report.observations.map((observation) => {
        const runtimeFiles = [
          ...new Set([
            ...observation.files,
            ...importedProjectFiles(
              resolve(root, observation.file),
              root,
            ),
          ]),
        ].sort()
        const framework = resolveFrameworkEdges(adapters, {
          files: runtimeFiles,
          root,
          testFile: observation.file,
        })
        frameworkEvidenceComplete &&= framework.complete
        return {
          ...observation,
          dependenciesComplete:
            observation.dependenciesComplete && framework.complete,
          files: [...new Set([...runtimeFiles, ...framework.files])].sort(),
        }
      })
      if (!frameworkEvidenceComplete) {
        if (this.options.log ?? true) {
          console.warn(
            'TIA graph was not updated because a Playwright framework edge adapter failed.',
          )
        }
        return { plan, status, success: status === 0 }
      }
      await core.commit(
        observations,
        [...new Set(observations.map((observation) => observation.file))],
      )
      return { plan, status, success: status === 0 }
    } finally {
      if (existsSync(session)) {
        rmSync(session, { force: true })
      }
    }
  }
}
