export interface TiaFrameworkEdgeContext {
  files: string[]
  root: string
  testFile: string
}

export interface TiaFrameworkEdgeAdapter {
  name: string
  fingerprint?: string
  resolve(context: TiaFrameworkEdgeContext): string[]
}

export interface TiaDatabaseEdgeOptions {
  migrations?: string[]
  schemas?: string[]
}

export interface TiaViewEdgeOptions {
  extensions?: string[]
  roots?: string[]
}

export interface TiaSubprocessEdgeMapping {
  files: string[]
  tests: string[]
}

export interface TiaSubprocessEdgeOptions {
  mappings: TiaSubprocessEdgeMapping[]
}

export interface TiaFrameworkOptions {
  adapters?: TiaFrameworkEdgeAdapter | TiaFrameworkEdgeAdapter[]
  database?: boolean | TiaDatabaseEdgeOptions
  subprocess?: TiaSubprocessEdgeOptions
  views?: boolean | TiaViewEdgeOptions
}
