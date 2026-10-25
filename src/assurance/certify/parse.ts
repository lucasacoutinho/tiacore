import * as Schema from 'effect/Schema'

import { byCodeUnit } from '../../core/canonical.ts'
import {
  judgeReceipt,
  type TiaAdapterCertification,
  type TiaAdapterCertificationReceipt,
} from '../../core/conformance.ts'
import { valueOrThrow } from '../../wire/issue.ts'
import { CertificationReceipt } from './receipt.ts'

const decodeReceipt = Schema.decodeUnknownExit(CertificationReceipt)

/** Validates a certification receipt and returns it in canonical order. */
export function parseAdapterCertificationReceipt(
  value: unknown,
): TiaAdapterCertificationReceipt {
  const receipt: TiaAdapterCertificationReceipt = valueOrThrow(
    'TIA adapter certification receipt',
    decodeReceipt(value, { onExcessProperty: 'error' }),
  )
  return {
    ...receipt,
    features: [...receipt.features].sort(byCodeUnit),
    scenarios: [...receipt.scenarios].sort((left, right) =>
      byCodeUnit(left.id, right.id),
    ),
  }
}

/** Parses a receipt and throws unless every required scenario passed. */
export function certifyAdapterReceipt(value: unknown): TiaAdapterCertification {
  const verdict = judgeReceipt(parseAdapterCertificationReceipt(value))
  if ('failure' in verdict) throw new Error(verdict.failure)
  return verdict.certification
}
