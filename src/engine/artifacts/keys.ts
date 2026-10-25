import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'

// Ed25519 key input. 1.x accepted only PEM with real newlines. Keys also
// travel through CI secrets and environment variables, which flatten newlines
// to a literal `\n` or drop the PEM armor altogether, so all three forms are
// accepted: PEM, PEM with literal `\n`, and base64 (or base64url) DER.

const ARMOR = '-----BEGIN'

function derBytes(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/gu, ''), 'base64')
}

export function parsePrivateKey(text: string): KeyObject {
  const trimmed = text.trim()
  return trimmed.includes(ARMOR)
    ? createPrivateKey(trimmed.replaceAll('\\n', '\n'))
    : createPrivateKey({ format: 'der', key: derBytes(trimmed), type: 'pkcs8' })
}

export function parsePublicKey(text: string): KeyObject {
  const trimmed = text.trim()
  return trimmed.includes(ARMOR)
    ? createPublicKey(trimmed.replaceAll('\\n', '\n'))
    : createPublicKey({ format: 'der', key: derBytes(trimmed), type: 'spki' })
}
