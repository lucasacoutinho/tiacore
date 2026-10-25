export const VERSION = '2.0.0'

/** The Node.js versions tiacore supports; `package.json` `engines.node` repeats it. */
export const NODE_ENGINES = '^22.12.0 || >=24.0.0'

/** The tool versions tiacore works with; `package.json` `peerDependencies` repeats them. */
export const PEER_RANGES = {
  '@playwright/test': '>=1.46.0 <2.0.0',
  vite: '>=6.0.0 <9.0.0',
  vitest: '>=4.1.0 <6.0.0',
} as const
