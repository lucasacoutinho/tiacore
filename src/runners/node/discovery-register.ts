import { Module, registerHooks } from 'node:module'

import * as shimModule from './discovery-shim.ts'

// Loaded with `node --import` before a test file during discovery. It points
// `node:test` (and the bare `test` specifier) at the recording shim for both
// module systems. This module is an esbuild entry point, so it and the shim
// are real files in dist.

const shimUrl = new URL('./discovery-shim.js', import.meta.url).href

// What `require('node:test')` returns: the callable `test` carrying every
// named export, like the real module.
const commonJsShim = Object.assign(shimModule.default, shimModule)

const originalRequire = Module.prototype.require

Module.prototype.require = function requireWithDiscoveryShim(
  this: NodeJS.Module,
  specifier: string,
) {
  if (specifier === 'node:test' || specifier === 'test') return commonJsShim
  return originalRequire.call(this, specifier)
} as typeof Module.prototype.require

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier === 'node:test' || specifier === 'test') &&
      !new Set(context.conditions).has('require')
    ) {
      return { shortCircuit: true, url: shimUrl }
    }
    return nextResolve(specifier, context)
  },
})
