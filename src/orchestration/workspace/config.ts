import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  tia,
  TiaWorkspaceRunner,
  type TiaWorkspaceOptions,
} from '../workspace.js'

export async function runWorkspaceCommand(options: {
  config: string
  output?: string
}): Promise<void> {
  const configPath = resolve(options.config)
  const loaded = (await import(pathToFileURL(configPath).href)) as {
    default?: TiaWorkspaceOptions | TiaWorkspaceRunner
    workspace?: TiaWorkspaceOptions | TiaWorkspaceRunner
  }
  const configured = loaded.default ?? loaded.workspace
  if (configured === undefined) {
    throw new Error(
      `TIA workspace config ${options.config} must export default or workspace`,
    )
  }
  const runner =
    configured instanceof TiaWorkspaceRunner ? configured : tia(configured)
  const result = await runner.run()
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  if (options.output === undefined || options.output === '-') {
    process.stdout.write(serialized)
  } else {
    await writeFile(options.output, serialized, 'utf8')
  }
  if (!result.success) process.exitCode = 1
}
