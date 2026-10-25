import type {
  TiaVerificationOptions,
  TiaVerificationReceipt,
} from '../../core/verification.ts'
import { runPromise } from '../../host/runtime.ts'
import { normalized, verify } from './runner.ts'

// The public Promise surface of the verifier. Effect stays in runner.ts, so
// no public declaration file reaches it.

export class TiaVerifier {
  private readonly options: TiaVerificationOptions

  constructor(options: TiaVerificationOptions) {
    this.options = normalized(options)
  }

  run(): Promise<TiaVerificationReceipt> {
    return runPromise(verify(this.options))
  }
}

export function tia(options: TiaVerificationOptions): TiaVerifier {
  return new TiaVerifier(options)
}
