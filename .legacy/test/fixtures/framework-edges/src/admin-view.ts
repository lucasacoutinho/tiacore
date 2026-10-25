import ejs from 'ejs'
import { fileURLToPath } from 'node:url'

export async function adminView(): Promise<string> {
  return ejs.renderFile(
    fileURLToPath(new URL('../views/admin.ejs', import.meta.url)),
    { count: 2 },
  )
}
