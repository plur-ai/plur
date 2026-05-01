import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { readCapsule, verifyCapsuleIntegrity, writeCapsule } from '../src/capsule.js'
import {
  CAPSULE_FLAGS,
  CAPSULE_MAGIC,
  ED25519_SIG_LEN,
  FORMAT_VERSION_V1,
  PREAMBLE_LEN,
  hasFlag,
  parseCapsulePreamble,
  serializeCapsulePreamble,
} from '../src/schemas/capsule.js'

const baseSummary = {
  name: 'engineering-conventions',
  version: '0.3.1',
  creator: 'plur9',
  engram_count: 147,
  domain: 'engineering',
  license: 'cc-by-sa-4.0',
}
const baseProducer = { tool: '@plur-ai/core', version: '0.9.3' }

describe('writeCapsule + readCapsule', () => {
  it('round-trips an unsigned, gzip-flagged capsule', () => {
    const payload = Buffer.from('pretend-this-is-a-tar-gz-archive')
    const capsule = writeCapsule({
      payload,
      manifestSummary: baseSummary,
      producer: baseProducer,
      sizeUncompressed: 99999,
      createdAt: '2026-04-30T20:30:00Z',
    })

    expect(capsule.subarray(0, 4).equals(CAPSULE_MAGIC)).toBe(true)

    const result = readCapsule(capsule)
    expect(result.header.schema).toBe('plur.capsule/1')
    expect(result.header.product_type).toBe('engram-pack')
    expect(result.header.manifest_summary.name).toBe('engineering-conventions')
    expect(result.header.payload.compression).toBe('gzip')
    expect(result.header.payload.size_compressed).toBe(payload.length)
    expect(result.header.payload.size_uncompressed).toBe(99999)
    expect(result.header.signer).toBeNull()
    expect(result.payload.equals(payload)).toBe(true)
    expect(result.signature).toBeNull()
  })

  it('sets COMPRESSED flag when compression=gzip and clears it for none', () => {
    const payload = Buffer.from('plain-bytes')

    const gz = writeCapsule({
      payload,
      manifestSummary: baseSummary,
      producer: baseProducer,
      compression: 'gzip',
    })
    expect(hasFlag(parseCapsulePreamble(gz).flags, CAPSULE_FLAGS.COMPRESSED)).toBe(true)

    const plain = writeCapsule({
      payload,
      manifestSummary: baseSummary,
      producer: baseProducer,
      compression: 'none',
    })
    expect(hasFlag(parseCapsulePreamble(plain).flags, CAPSULE_FLAGS.COMPRESSED)).toBe(false)

    const r = readCapsule(plain)
    expect(r.header.payload.compression).toBe('none')
  })

  it('round-trips a signed capsule with a 64-byte signature', () => {
    const payload = Buffer.from('signed-payload-bytes')
    const signature = Buffer.alloc(ED25519_SIG_LEN, 0xab)
    const capsule = writeCapsule({
      payload,
      manifestSummary: baseSummary,
      producer: baseProducer,
      signer: { algo: 'ed25519', public_key: 'k'.repeat(44), key_id: 'plur9/main' },
      signature,
    })

    const preamble = parseCapsulePreamble(capsule)
    expect(hasFlag(preamble.flags, CAPSULE_FLAGS.SIGNED)).toBe(true)

    const r = readCapsule(capsule)
    expect(r.header.signer?.algo).toBe('ed25519')
    expect(r.signature?.length).toBe(ED25519_SIG_LEN)
    expect(r.signature?.equals(signature)).toBe(true)
    expect(r.payload.equals(payload)).toBe(true)
  })

  it('rejects writer signer-without-signature and signature-without-signer', () => {
    expect(() =>
      writeCapsule({
        payload: Buffer.from('x'),
        manifestSummary: baseSummary,
        producer: baseProducer,
        signer: { algo: 'ed25519', public_key: 'k'.repeat(44) },
      }),
    ).toThrow(/signer set but signature/)

    expect(() =>
      writeCapsule({
        payload: Buffer.from('x'),
        manifestSummary: baseSummary,
        producer: baseProducer,
        signature: Buffer.alloc(ED25519_SIG_LEN, 0xcd),
      }),
    ).toThrow(/signature provided without signer/)
  })

  it('readCapsule detects payload tampering via sha256', () => {
    const payload = Buffer.from('original-bytes')
    const capsule = writeCapsule({
      payload,
      manifestSummary: baseSummary,
      producer: baseProducer,
    })
    const tampered = Buffer.from(capsule)
    tampered[tampered.length - 1] ^= 0xff
    expect(() => readCapsule(tampered)).toThrow(/integrity mismatch/)
  })

  it('readCapsule detects truncated header region', () => {
    const payload = Buffer.from('tar-gz-stub')
    const capsule = writeCapsule({
      payload,
      manifestSummary: baseSummary,
      producer: baseProducer,
    })
    // Bump HeaderLen past the capsule's own length.
    const preamble = parseCapsulePreamble(capsule)
    const fakePreamble = serializeCapsulePreamble({
      formatVersion: preamble.formatVersion,
      flags: preamble.flags,
      headerLen: capsule.length + 1024,
    })
    const tampered = Buffer.concat([fakePreamble, capsule.subarray(PREAMBLE_LEN)])
    expect(() => readCapsule(tampered)).toThrow(/truncated header/)
  })

  it('readCapsule rejects malformed header JSON', () => {
    const payload = Buffer.from('p')
    const headerJson = Buffer.from('this-is-not-json{{{', 'utf-8')
    const sha256 = createHash('sha256').update(payload).digest('hex')
    const preamble = serializeCapsulePreamble({
      formatVersion: FORMAT_VERSION_V1,
      flags: 0,
      headerLen: headerJson.length,
    })
    void sha256
    const buf = Buffer.concat([preamble, headerJson, payload])
    expect(() => readCapsule(buf)).toThrow(/malformed header JSON/)
  })

  it('readCapsule rejects flag/header compression disagreement', () => {
    const payload = Buffer.from('p'.repeat(8))
    // Build a capsule with COMPRESSED flag set but header.payload.compression='none'.
    const sha256 = createHash('sha256').update(payload).digest('hex')
    const headerObj = {
      schema: 'plur.capsule/1',
      product_type: 'engram-pack',
      manifest_summary: baseSummary,
      payload: {
        compression: 'none',
        size_compressed: payload.length,
        size_uncompressed: payload.length,
        sha256,
      },
      created_at: '2026-04-30T20:30:00Z',
      producer: baseProducer,
      signer: null,
    }
    const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf-8')
    const preamble = serializeCapsulePreamble({
      formatVersion: FORMAT_VERSION_V1,
      flags: CAPSULE_FLAGS.COMPRESSED,
      headerLen: headerJson.length,
    })
    const buf = Buffer.concat([preamble, headerJson, payload])
    expect(() => readCapsule(buf)).toThrow(/COMPRESSED flag/)
  })

  it('verifyCapsuleIntegrity returns true for round-trip and false for tamper', () => {
    const payload = Buffer.from('verify-me')
    const capsule = writeCapsule({
      payload,
      manifestSummary: baseSummary,
      producer: baseProducer,
    })
    expect(verifyCapsuleIntegrity(capsule)).toBe(true)
    const tampered = Buffer.from(capsule)
    tampered[PREAMBLE_LEN + 5] ^= 0x01
    expect(verifyCapsuleIntegrity(tampered)).toBe(false)
  })
})
