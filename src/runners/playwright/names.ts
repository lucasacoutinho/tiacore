/** The lane name derived from a config file's base name (`playwright.qa.config.ts` gives `playwright-qa`). */
export function runnerName(configBasename: string): string {
  const configName = configBasename
    .replace(/\.[cm]?[jt]s$/u, '')
    .replace(/^playwright(?:\.|$)/u, '')
  const stem = (configName === 'config' ? '' : configName)
    .replace(/\.config$/u, '')
    .replace(/[^a-z\d]+/giu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase()
  return stem === '' ? 'playwright' : `playwright-${stem}`
}

/** The lane name for an explicit `name` option, or the config's when it is absent. */
export function configuredRunnerName(
  configBasename: string,
  name: string | undefined,
): string {
  if (name === undefined) return runnerName(configBasename)
  const stem = name
    .replace(/[^a-z\d]+/giu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase()
  if (stem === '') {
    throw new Error('Playwright TIA name must contain a letter or number.')
  }
  return stem.startsWith('playwright-') || stem === 'playwright'
    ? stem
    : `playwright-${stem}`
}
