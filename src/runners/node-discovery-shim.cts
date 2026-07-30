interface DiscoveryShim {
  default: ((...arguments_: unknown[]) => unknown) & Record<string, unknown>
  [key: string]: unknown
}

const shim = require('./node-discovery-shim.js') as DiscoveryShim

Object.assign(shim.default, shim)
export = shim.default
