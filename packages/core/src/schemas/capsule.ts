import { z } from 'zod'

// .plur capsule v1 — binary envelope for engram packs.
// Spec: plur-ai/plur#61 §1–§6 (sketch becomes floor at 2026-04-29 window close).
// Layout: MAGIC | FormatVersion | Flags | HeaderLen | Header(JSON) | Payload(tar.gz) | Sig?

export const CAPSULE_MAGIC = Buffer.from([0x50, 0x4c, 0x55, 0x52])
export const CAPSULE_MAGIC_HEX = '50 4c 55 52'

export const FORMAT_VERSION_V1 = 0x0001
export const SUPPORTED_FORMAT_VERSIONS = [FORMAT_VERSION_V1] as const

export const CAPSULE_FLAGS = {
  SIGNED: 1 << 0,
  COMPRESSED: 1 << 1,
} as const
export const CAPSULE_FLAG_RESERVED_MASK = 0xfffc

export const PREAMBLE_LEN = 12

export const CAPSULE_SIZE_LIMITS = {
  SOFT_BYTES: 100 * 1024 * 1024,
  HARD_BYTES: 1024 * 1024 * 1024,
} as const

export const ED25519_SIG_LEN = 64

export const ManifestSummarySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  creator: z.string().optional(),
  engram_count: z.number().int().min(0),
  domain: z.string().optional(),
  license: z.string().default('cc-by-sa-4.0'),
})
export type ManifestSummary = z.infer<typeof ManifestSummarySchema>

export const PayloadDescriptorSchema = z.object({
  compression: z.enum(['gzip', 'none']),
  size_compressed: z.number().int().min(0),
  size_uncompressed: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex chars'),
})
export type PayloadDescriptor = z.infer<typeof PayloadDescriptorSchema>

export const ProducerSchema = z.object({
  tool: z.string().min(1),
  version: z.string().min(1),
  agent_id: z.string().optional(),
})
export type Producer = z.infer<typeof ProducerSchema>

export const SignerSchema = z.object({
  algo: z.literal('ed25519'),
  public_key: z.string().min(1),
  key_id: z.string().optional(),
})
export type Signer = z.infer<typeof SignerSchema>

export const CapsuleHeaderSchema = z.object({
  schema: z.literal('plur.capsule/1'),
  product_type: z.enum(['engram-pack', 'skill']),
  manifest_summary: ManifestSummarySchema,
  payload: PayloadDescriptorSchema,
  created_at: z.string().datetime({ offset: true }),
  producer: ProducerSchema,
  signer: SignerSchema.nullable().default(null),
})
export type CapsuleHeader = z.infer<typeof CapsuleHeaderSchema>

export interface CapsulePreamble {
  formatVersion: number
  flags: number
  headerLen: number
}

export function parseCapsulePreamble(buf: Buffer): CapsulePreamble {
  if (buf.length < PREAMBLE_LEN) {
    throw new Error(`capsule: truncated preamble (got ${buf.length} bytes, need ${PREAMBLE_LEN})`)
  }
  if (buf.compare(CAPSULE_MAGIC, 0, 4, 0, 4) !== 0) {
    throw new Error(`capsule: bad magic (expected ${CAPSULE_MAGIC_HEX})`)
  }
  const formatVersion = buf.readUInt16LE(4)
  if (!SUPPORTED_FORMAT_VERSIONS.includes(formatVersion as typeof FORMAT_VERSION_V1)) {
    throw new Error(`capsule: unsupported FormatVersion 0x${formatVersion.toString(16).padStart(4, '0')}`)
  }
  const flags = buf.readUInt16LE(6)
  if ((flags & CAPSULE_FLAG_RESERVED_MASK) !== 0) {
    throw new Error(`capsule: reserved flag bits set (flags=0x${flags.toString(16).padStart(4, '0')})`)
  }
  const headerLen = buf.readUInt32LE(8)
  if (headerLen === 0) {
    throw new Error('capsule: HeaderLen must be > 0')
  }
  if (headerLen > CAPSULE_SIZE_LIMITS.HARD_BYTES) {
    throw new Error(`capsule: HeaderLen ${headerLen} exceeds hard size limit`)
  }
  return { formatVersion, flags, headerLen }
}

export function serializeCapsulePreamble(p: CapsulePreamble): Buffer {
  const buf = Buffer.alloc(PREAMBLE_LEN)
  CAPSULE_MAGIC.copy(buf, 0)
  buf.writeUInt16LE(p.formatVersion, 4)
  buf.writeUInt16LE(p.flags, 6)
  buf.writeUInt32LE(p.headerLen, 8)
  return buf
}

export function hasFlag(flags: number, flag: number): boolean {
  return (flags & flag) === flag
}
