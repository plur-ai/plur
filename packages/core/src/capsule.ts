import { createHash } from 'node:crypto'
import {
  CAPSULE_FLAGS,
  CAPSULE_SIZE_LIMITS,
  CapsuleHeader,
  CapsuleHeaderSchema,
  ED25519_SIG_LEN,
  FORMAT_VERSION_V1,
  ManifestSummary,
  PREAMBLE_LEN,
  Producer,
  Signer,
  hasFlag,
  parseCapsulePreamble,
  serializeCapsulePreamble,
} from './schemas/capsule.js'

// .plur capsule v1 — envelope writer/reader.
// Spec: plur-ai/plur#61 §1–§5 (slice 2 of 4-slice plan).
// Slice 1 shipped the schema + preamble (PR #66 / e06fb08).
// This slice adds writeCapsule / readCapsule around tar.gz payloads.
//
// Layout (LE throughout):
//   MAGIC(4) | FormatVersion(2) | Flags(2) | HeaderLen(4)
//   Header(JSON, utf-8, HeaderLen bytes)
//   Payload(opaque bytes — typically tar.gz of {manifest.yaml + engrams.yaml})
//   Signature(64 bytes, Ed25519 — only if Flags.SIGNED is set; deferred for MVP)

export interface WriteCapsuleOptions {
  payload: Buffer
  manifestSummary: ManifestSummary
  producer: Producer
  productType?: 'engram-pack' | 'skill'
  compression?: 'gzip' | 'none'
  sizeUncompressed?: number
  createdAt?: string
  signer?: Signer | null
  signature?: Buffer
}

export interface ReadCapsuleResult {
  header: CapsuleHeader
  payload: Buffer
  signature: Buffer | null
}

export function writeCapsule(opts: WriteCapsuleOptions): Buffer {
  const compression = opts.compression ?? 'gzip'
  const productType = opts.productType ?? 'engram-pack'
  const createdAt = opts.createdAt ?? new Date().toISOString()
  const signer = opts.signer ?? null

  if (signer !== null && (!opts.signature || opts.signature.length !== ED25519_SIG_LEN)) {
    throw new Error(`writeCapsule: signer set but signature missing or not ${ED25519_SIG_LEN} bytes`)
  }
  if (signer === null && opts.signature) {
    throw new Error('writeCapsule: signature provided without signer — refuse ambiguous envelope')
  }

  const sha256 = createHash('sha256').update(opts.payload).digest('hex')
  const sizeCompressed = opts.payload.length
  const sizeUncompressed = opts.sizeUncompressed ?? sizeCompressed

  const header: CapsuleHeader = CapsuleHeaderSchema.parse({
    schema: 'plur.capsule/1',
    product_type: productType,
    manifest_summary: opts.manifestSummary,
    payload: {
      compression,
      size_compressed: sizeCompressed,
      size_uncompressed: sizeUncompressed,
      sha256,
    },
    created_at: createdAt,
    producer: opts.producer,
    signer,
  })

  const headerJson = Buffer.from(JSON.stringify(header), 'utf-8')

  let flags = 0
  if (compression === 'gzip') flags |= CAPSULE_FLAGS.COMPRESSED
  if (signer !== null) flags |= CAPSULE_FLAGS.SIGNED

  const preamble = serializeCapsulePreamble({
    formatVersion: FORMAT_VERSION_V1,
    flags,
    headerLen: headerJson.length,
  })

  const totalLen =
    PREAMBLE_LEN + headerJson.length + opts.payload.length + (signer !== null ? ED25519_SIG_LEN : 0)
  if (totalLen > CAPSULE_SIZE_LIMITS.HARD_BYTES) {
    throw new Error(`writeCapsule: capsule size ${totalLen} exceeds hard limit`)
  }

  const parts: Buffer[] = [preamble, headerJson, opts.payload]
  if (signer !== null && opts.signature) parts.push(opts.signature)
  return Buffer.concat(parts, totalLen)
}

export function readCapsule(buf: Buffer): ReadCapsuleResult {
  if (buf.length > CAPSULE_SIZE_LIMITS.HARD_BYTES) {
    throw new Error(`readCapsule: capsule size ${buf.length} exceeds hard limit`)
  }

  const preamble = parseCapsulePreamble(buf)
  const headerStart = PREAMBLE_LEN
  const headerEnd = headerStart + preamble.headerLen
  if (buf.length < headerEnd) {
    throw new Error(`readCapsule: truncated header (need ${headerEnd} bytes, got ${buf.length})`)
  }

  const headerJson = buf.subarray(headerStart, headerEnd).toString('utf-8')
  let parsedHeader: unknown
  try {
    parsedHeader = JSON.parse(headerJson)
  } catch (err) {
    throw new Error(`readCapsule: malformed header JSON — ${(err as Error).message}`)
  }
  const header = CapsuleHeaderSchema.parse(parsedHeader)

  const isSigned = hasFlag(preamble.flags, CAPSULE_FLAGS.SIGNED)
  const sigLen = isSigned ? ED25519_SIG_LEN : 0
  const payloadEnd = buf.length - sigLen
  if (payloadEnd < headerEnd) {
    throw new Error('readCapsule: payload region underflow')
  }

  const payload = buf.subarray(headerEnd, payloadEnd)
  const signature = isSigned ? buf.subarray(payloadEnd) : null

  if (payload.length !== header.payload.size_compressed) {
    throw new Error(
      `readCapsule: payload size mismatch (header=${header.payload.size_compressed}, actual=${payload.length})`,
    )
  }
  const actualSha = createHash('sha256').update(payload).digest('hex')
  if (actualSha !== header.payload.sha256) {
    throw new Error(`readCapsule: integrity mismatch (header=${header.payload.sha256}, actual=${actualSha})`)
  }

  const compressionFlagSet = hasFlag(preamble.flags, CAPSULE_FLAGS.COMPRESSED)
  const headerSaysCompressed = header.payload.compression === 'gzip'
  if (compressionFlagSet !== headerSaysCompressed) {
    throw new Error(
      `readCapsule: COMPRESSED flag (${compressionFlagSet}) disagrees with header.payload.compression (${header.payload.compression})`,
    )
  }

  return { header, payload: Buffer.from(payload), signature: signature ? Buffer.from(signature) : null }
}

export function verifyCapsuleIntegrity(buf: Buffer): boolean {
  try {
    readCapsule(buf)
    return true
  } catch {
    return false
  }
}
