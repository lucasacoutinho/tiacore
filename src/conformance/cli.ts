import type { Command } from 'commander'

import { emit, readJson } from '../cli/shared.js'
import { certifyAdapterReceipt } from './certification.js'
import {
  executeAdapterCertification,
  type TiaExecutableCertificationOptions,
} from './executable.js'

export function registerConformanceCommands(program: Command): void {
  const certify = program
    .command('certify')
    .description('Certification commands')
  certify
    .command('adapter')
    .description('Validate an adapter certification receipt')
    .requiredOption('--receipt <path>', 'adapter receipt JSON')
    .option('--output <path>', 'write JSON to a file or -')
    .action(async (options: { output?: string; receipt: string }) => {
      await emit(
        certifyAdapterReceipt(await readJson(options.receipt)),
        options.output,
      )
    })
  certify
    .command('execute')
    .description('Execute an adapter certification specification')
    .requiredOption('--spec <path>', 'executable certification specification')
    .option('--output <path>', 'write the receipt to a file or -')
    .action(async (options: { output?: string; spec: string }) => {
      const receipt = await executeAdapterCertification(
        (await readJson(options.spec)) as TiaExecutableCertificationOptions,
      )
      await emit(receipt, options.output)
      try {
        certifyAdapterReceipt(receipt)
      } catch {
        process.exitCode = 1
      }
    })
}
