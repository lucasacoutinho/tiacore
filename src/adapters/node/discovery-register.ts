import { createRequire, Module, registerHooks } from 'node:module'

const shim = new URL('./discovery-shim.js', import.meta.url).href
const commonJsShim: unknown = createRequire(import.meta.url)(
  './discovery-shim.cjs',
)
const originalRequire = Module.prototype.require

Module.prototype.require = function requireWithDiscoveryShim(
  specifier: string,
) {
  if (specifier === 'node:test' || specifier === 'test') {
    return commonJsShim
  }

  return originalRequire.call(this, specifier)
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier === 'node:test' || specifier === 'test') &&
      !new Set(context.conditions).has('require')
    ) {
      return {
        shortCircuit: true,
        url: shim,
      }
    }

    return nextResolve(specifier, context)
  },
})
