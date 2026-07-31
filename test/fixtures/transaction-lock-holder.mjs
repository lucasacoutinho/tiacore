import {
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

const cacheDir = process.argv[2]
if (cacheDir === undefined) {
  process.exitCode = 64
} else {
  const lock = join(cacheDir, 'state.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(
    join(lock, 'owner.json'),
    `${JSON.stringify({
      createdAt: Date.now(),
      hostname: hostname(),
      pid: process.pid,
      token: 'injected-crash',
    })}\n`,
  )
  writeFileSync(
    join(
      cacheDir,
      `state.json.${process.pid}.00000000-0000-4000-8000-000000000000.tmp`,
    ),
    '{"incomplete":',
  )
  process.stdout.write('ready\n')
  setInterval(() => {}, 60_000)
}
