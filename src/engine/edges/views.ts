import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'

import { slash } from '../host-path.ts'
import type { TiaFrameworkEdgeAdapter, TiaViewEdgeOptions } from './types.ts'

const DEFAULT_EXTENSIONS = [
  '.ejs',
  '.eta',
  '.hbs',
  '.handlebars',
  '.html',
  '.liquid',
  '.njk',
  '.nunjucks',
  '.pug',
]
const DEFAULT_ROOTS = ['views', 'templates', 'src/views', 'src/templates']

function escapedExtensions(extensions: string[]): string {
  return extensions
    .map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
}

export function viewEdges(
  configured: true | TiaViewEdgeOptions,
): TiaFrameworkEdgeAdapter {
  const options = configured === true ? {} : configured
  const extensions = (options.extensions ?? DEFAULT_EXTENSIONS).map(
    (extension) => (extension.startsWith('.') ? extension : `.${extension}`),
  )
  const roots = options.roots ?? DEFAULT_ROOTS
  const literalPattern = new RegExp(
    `["'\`]([^"'\\n]+(?:${escapedExtensions(extensions)}))["'\`]`,
    'g',
  )
  const callPattern =
    /\b(?:render|renderFile|compileFile|template)\s*\(\s*["'`]([^"'`]+)["'`]/g

  return {
    fingerprint: JSON.stringify({ extensions, roots, version: 1 }),
    name: 'views',
    resolve(context) {
      const found = new Set<string>()

      for (const dependency of context.files) {
        let source: string
        try {
          source = readFileSync(resolve(context.root, dependency), 'utf8')
        } catch {
          continue
        }

        const names = new Set<string>()
        for (const match of source.matchAll(literalPattern)) {
          if (match[1] !== undefined) {
            names.add(match[1])
          }
        }
        for (const match of source.matchAll(callPattern)) {
          if (match[1] !== undefined) {
            names.add(match[1])
          }
        }

        for (const name of names) {
          const candidates = new Set<string>()
          const suffixes = extname(name) === '' ? extensions : ['']
          for (const suffix of suffixes) {
            candidates.add(
              resolve(context.root, dirname(dependency), `${name}${suffix}`),
            )
            for (const root of roots) {
              candidates.add(resolve(context.root, root, `${name}${suffix}`))
            }
          }

          for (const candidate of candidates) {
            if (existsSync(candidate)) {
              found.add(slash(relative(context.root, candidate)))
            }
          }
        }
      }

      return [...found].sort()
    },
  }
}
