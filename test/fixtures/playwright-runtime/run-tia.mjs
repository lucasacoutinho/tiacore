import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

import { tia } from '@usescherie/tiacore/playwright'

const root = process.cwd()
const contentTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
}
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://fixture.test').pathname
  const file = resolve(root, pathname === '/' ? 'src/index.html' : `.${pathname}`)
  try {
    const body = await readFile(file)
    response.writeHead(200, {
      'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
    })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end()
  }
})

await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const address = server.address()
if (address === null || typeof address === 'string') {
  throw new Error('fixture server did not bind a TCP port')
}
process.env.BASE_URL = `http://127.0.0.1:${address.port}`

try {
  const result = await tia({
    config: 'playwright.config.ts',
    root,
  }).run()
  process.exitCode = result.success ? 0 : 1
} finally {
  await new Promise((closed) => server.close(closed))
}
