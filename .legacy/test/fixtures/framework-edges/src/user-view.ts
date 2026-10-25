import ejs from 'ejs'
import { fileURLToPath } from 'node:url'

export async function userView(): Promise<string> {
  return ejs.renderFile(
    fileURLToPath(new URL('../views/user.ejs', import.meta.url)),
    { name: 'Lucas' },
  )
}
