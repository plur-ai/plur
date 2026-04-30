import { describe, it, expect } from 'vitest'
import {
  CAPSULE_MAGIC,
  CAPSULE_FLAGS,
  FORMAT_VERSION_V1,
  PREAMBLE_LEN,
  CapsuleHeaderSchema,
  parseCapsulePreamble,
  serializeCapsulePreamble,
  hasFlag,
} from '../src/schemas/capsule.js'

describe('capsule preamble', () => {
  it('round-trips a valid preamble', () => {
    const out = serializeCapsulePreamble({ formatVersion: FORMAT_VERSION_V1, flags: 0, headerLen: 256 })
    expect(out.length).toBe(PREAMBLE_LEN)
    expect(out.subarray(0, 4).equals(CAPSULE_MAGIC)).toBe(true)
    const parsed = parseCapsulePreamble(out)
    expect(parsed).toEqual({ formatVersion: FORMAT_VERSION_V1, flags: 0, headerLen: 256 })
  })

  it('rejects bad magic bytes', () => {
    const buf = Buffer.alloc(PREAMBLE_LEN)
    buf.write('XXXX', 0, 4)
    buf.writeUInt32LE(64, 8)
    expect(() => parseCapsulePreamble(buf)).toThrow(/bad magic/)
  })

  it('rejects truncated preamble', () => {
    expect(() => parseCapsulePreamble(Buffer.alloc(8))).toThrow(/truncated preamble/)
  })

  it('rejects unsupported FormatVersion', () => {
    const buf = serializeCapsulePreamble({ formatVersion: 0x0099, flags: 0, headerLen: 64 })
    expect(() => parseCapsulePreamble(buf)).toThrow(/unsupported FormatVersion/)
  })

  it('rejects reserved flag bits', () => {
    const buf = serializeCapsulePreamble({ formatVersion: FORMAT_VERSION_V1, flags: 0x0004, headerLen: 64 })
    expect(() => parseCapsulePreamble(buf)).toThrow(/reserved flag bits/)
  })

  it('rejects zero HeaderLen', () => {
    const buf = serializeCapsulePreamble({ formatVersion: FORMAT_VERSION_V1, flags: 0, headerLen: 0 })
    expect(() => parseCapsulePreamble(buf)).toThrow(/HeaderLen must be > 0/)
  })

  it('accepts SIGNED and COMPRESSED flag bits', () => {
    const flags = CAPSULE_FLAGS.SIGNED | CAPSULE_FLAGS.COMPRESSED
    const buf = serializeCapsulePreamble({ formatVersion: FORMAT_VERSION_V1, flags, headerLen: 64 })
    const parsed = parseCapsulePreamble(buf)
    expect(hasFlag(parsed.flags, CAPSULE_FLAGS.SIGNED)).toBe(true)
    expect(hasFlag(parsed.flags, CAPSULE_FLAGS.COMPRESSED)).toBe(true)
  })
})

describe('CapsuleHeaderSchema', () => {
  const validHeader = {
    schema: 'plur.capsule/1',
    product_type: 'engram-pack',
    manifest_summary: {
      name: 'engineering-conventions',
      version: '0.3.1',
      creator: 'plur9',
      engram_count: 147,
      domain: 'engineering',
      license: 'cc-by-sa-4.0',
    },
    payload: {
      compression: 'gzip',
      size_compressed: 54321,
      size_uncompressed: 198765,
      sha256: 'a'.repeat(64),
    },
    created_at: '2026-04-29T19:30:00Z',
    producer: { tool: '@plur-ai/core', version: '0.9.3' },
    signer: null,
  }

  it('accepts a valid v1 header', () => {
    const result = CapsuleHeaderSchema.parse(validHeader)
    expect(result.schema).toBe('plur.capsule/1')
    expect(result.signer).toBeNull()
  })

  it('rejects wrong schema string', () => {
    expect(() => CapsuleHeaderSchema.parse({ ...validHeader, schema: 'plur.capsule/2' })).toThrow()
  })

  it('rejects malformed sha256', () => {
    expect(() =>
      CapsuleHeaderSchema.parse({ ...validHeader, payload: { ...validHeader.payload, sha256: 'not-hex' } }),
    ).toThrow()
  })

  it('rejects unknown product_type', () => {
    expect(() => CapsuleHeaderSchema.parse({ ...validHeader, product_type: 'mystery' })).toThrow()
  })

  it('defaults signer to null when omitted', () => {
    const { signer: _, ...withoutSigner } = validHeader
    const result = CapsuleHeaderSchema.parse(withoutSigner)
    expect(result.signer).toBeNull()
  })

  it('accepts optional producer.agent_id slot (Hermes §7.1)', () => {
    const result = CapsuleHeaderSchema.parse({
      ...validHeader,
      producer: { ...validHeader.producer, agent_id: 'hermes-1' },
    })
    expect(result.producer.agent_id).toBe('hermes-1')
  })
})
