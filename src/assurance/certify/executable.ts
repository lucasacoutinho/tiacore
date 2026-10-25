import type {
  TiaAdapterCertificationReceipt,
  TiaExecutableCertificationOptions,
} from '../../core/conformance.ts'
import { runPromise } from '../../host/runtime.ts'
import { executeCertification } from './execute.ts'

export type {
  TiaExecutableCertificationOptions,
  TiaExecutableScenario,
} from '../../core/conformance.ts'

// The public Promise surface of executable certification. Effect stays in
// execute.ts, so no public declaration file reaches it.

export function executeAdapterCertification(
  options: TiaExecutableCertificationOptions,
): Promise<TiaAdapterCertificationReceipt> {
  return runPromise(executeCertification(options))
}
