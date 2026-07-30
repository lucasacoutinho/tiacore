import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PUBLIC_REGISTRY_HOSTS = new Set([
  'registry.npmjs.com',
  'registry.npmjs.org',
])

function privateRegistry(value) {
  if (value === undefined || value.trim() === '') {
    throw new Error('TIA_REGISTRY_URL must identify the private npm registry')
  }
  const registry = new URL(value)
  if (registry.protocol !== 'https:' && registry.protocol !== 'http:') {
    throw new Error('TIA_REGISTRY_URL must use HTTP or HTTPS')
  }
  if (PUBLIC_REGISTRY_HOSTS.has(registry.hostname.toLowerCase())) {
    throw new Error('refusing to publish proprietary tiacore to the public npm registry')
  }
  if (!registry.pathname.endsWith('/')) registry.pathname += '/'
  return registry
}

function publish() {
  const dryRun = process.argv.slice(2).includes('--dry-run')
  const registry = privateRegistry(process.env.TIA_REGISTRY_URL)
  if (!dryRun && !process.env.NODE_AUTH_TOKEN) {
    throw new Error('NODE_AUTH_TOKEN is required for private publication')
  }

  const directory = mkdtempSync(join(tmpdir(), 'tiacore-publish-'))
  const npmrc = join(directory, 'npmrc')
  const authPath = `//${registry.host}${registry.pathname}`
  writeFileSync(
    npmrc,
    [
      `registry=${registry.href}`,
      `${authPath}:_authToken=\${NODE_AUTH_TOKEN}`,
      'access=restricted',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  )

  try {
    const result = spawnSync(
      'npm',
      [
        'publish',
        '--registry',
        registry.href,
        '--userconfig',
        npmrc,
        '--access',
        'restricted',
        ...(dryRun ? ['--dry-run'] : []),
      ],
      { stdio: 'inherit' },
    )
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

try {
  publish()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
