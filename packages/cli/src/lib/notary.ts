/**
 * Local check of the provenance gateway notary's signature (#1657).
 *
 * The notary signs `{data_hash}|{timestamp}` with Ethereum personal_sign
 * (EIP-191). `checkNotarySignature` recomputes data_hash and recovers the
 * signer here; the address it is compared with comes from the gateway unless
 * the caller pins one. Mirrors the Datacore provenance module's
 * `lib/crypto_verify.py`.
 */
import { createHash } from 'crypto'
import { keccak_256 } from '@noble/hashes/sha3'
import { secp256k1 } from '@noble/curves/secp256k1'
import type { NotarySignature } from '@plur-ai/core'

/** The SDK's toCanonicalJson: sorted keys, JSON.stringify for scalars. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

export function computeDataHash(signature: NotarySignature, doc: Record<string, unknown>): string {
  const fields = signature.hashed_fields ?? ['data']
  const value = fields.length === 1 && fields[0] === 'data'
    ? doc.data
    : Object.fromEntries(fields.map(f => [f, doc[f] ?? '']))
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

/** EIP-191 personal_sign recovery: the 0x address that signed `message`. */
export function recoverEip191(message: string, signatureHex: string): string {
  const hex = signatureHex.replace(/^0x/, '')
  if (hex.length !== 130) throw new Error('signature must be 65 bytes')
  const msg = Buffer.from(message, 'utf8')
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, 'utf8'), msg]))
  let v = parseInt(hex.slice(128, 130), 16)
  if (v >= 27) v -= 27
  if (v !== 0 && v !== 1) throw new Error('bad recovery id')
  const sig = secp256k1.Signature.fromCompact(hex.slice(0, 128)).addRecoveryBit(v)
  const pub = sig.recoverPublicKey(digest).toRawBytes(false).slice(1)
  return '0x' + Buffer.from(keccak_256(pub).slice(-20)).toString('hex')
}

export interface NotaryCheck {
  data_hash_ok: boolean
  signature_ok: boolean
  recovered: string | null
  claimed_signer: string | null
  timestamp: string | null
  error?: string
}

export function checkNotarySignature(signature: NotarySignature, doc: Record<string, unknown>): NotaryCheck {
  const out: NotaryCheck = {
    data_hash_ok: false,
    signature_ok: false,
    recovered: null,
    claimed_signer: signature.signer ?? null,
    timestamp: signature.timestamp ?? null,
  }
  const computed = computeDataHash(signature, doc)
  out.data_hash_ok = computed === signature.data_hash
  const fmt = signature.signed_message_format ?? '{data_hash}|{timestamp}'
  if (fmt !== '{data_hash}|{timestamp}') {
    out.error = `unknown signed_message_format ${fmt}`
    return out
  }
  try {
    out.recovered = recoverEip191(`${computed}|${signature.timestamp}`, signature.signature ?? '')
  } catch (err) {
    out.error = (err as Error).message
  }
  out.signature_ok = Boolean(out.data_hash_ok && out.recovered && out.recovered.toLowerCase() === (signature.signer ?? '').toLowerCase())
  return out
}
