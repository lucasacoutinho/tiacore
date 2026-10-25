import { spawn } from 'node:child_process'
import { platform, arch } from 'node:os'
import { resolve } from 'node:path'

import {
  TIA_ADAPTER_CONFORMANCE_VERSION,
  type TiaAdapterCapabilityLevel,
  type TiaAdapterCertificationReceipt,
  type TiaAdapterFeature,
} from './certification.js'
import { TIA_PROTOCOL_VERSION } from '../protocol/types.js'

const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 10 * 60 * 1000

export interface TiaExecutableScenario {
  arguments?: string[]
  assertions?: number
  command: string
  cwd?: string
  environment?: Record<string, string>
  fixture: string
  id: string
  timeoutMs?: number
}

export interface TiaExecutableCertificationOptions {
  adapter: string
  capabilityLevel: TiaAdapterCapabilityLevel
  features?: TiaAdapterFeature[]
  root?: string
  runner: { name: string; version: string }
  scenarios: TiaExecutableScenario[]
  selectionGranularity: TiaAdapterCertificationReceipt['selectionGranularity']
  sourceRevision: string
}

async function execute(
  root: string,
  scenario: TiaExecutableScenario,
): Promise<{ durationMs: number; passed: boolean }> {
  const timeoutMs = scenario.timeoutMs ?? 60_000
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(`invalid timeout for certification scenario ${scenario.id}`)
  }
  const started = performance.now()
  return new Promise((complete, reject) => {
    const child = spawn(scenario.command, scenario.arguments ?? [], {
      cwd: scenario.cwd ? resolve(root, scenario.cwd) : root,
      env: { ...process.env, ...scenario.environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let outputBytes = 0
    const observe = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) child.kill('SIGKILL')
    }
    child.stdout.on('data', observe)
    child.stderr.on('data', observe)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      complete({
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        passed: code === 0 && outputBytes <= MAX_OUTPUT_BYTES,
      })
    })
  })
}

export async function executeAdapterCertification(
  options: TiaExecutableCertificationOptions,
): Promise<TiaAdapterCertificationReceipt> {
  const root = resolve(options.root ?? process.cwd())
  const scenarios = []
  for (const scenario of options.scenarios) {
    const result = await execute(root, scenario)
    scenarios.push({
      evidence: {
        assertions: scenario.assertions ?? 1,
        command: [scenario.command, ...(scenario.arguments ?? [])].join(' '),
        durationMs: result.durationMs,
        fixture: scenario.fixture,
      },
      id: scenario.id,
      passed: result.passed,
    })
  }
  return {
    adapter: options.adapter,
    capabilityLevel: options.capabilityLevel,
    contractVersion: TIA_ADAPTER_CONFORMANCE_VERSION,
    environment: { architecture: arch(), operatingSystem: platform() },
    features: options.features ?? [],
    generatedAt: new Date().toISOString(),
    protocolVersion: TIA_PROTOCOL_VERSION,
    runner: options.runner,
    scenarios,
    selectionGranularity: options.selectionGranularity,
    sourceRevision: options.sourceRevision,
  }
}
