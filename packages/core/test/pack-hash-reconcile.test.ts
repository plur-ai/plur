import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import * as crypto from 'crypto'
import { computePackHash } from '../src/packs.js'
import { computePackChecksum, verifyPackChecksum } from '../src/trust.js'
import { loadPack } from '../src/engrams.js'

/**
 * Single §5.5 hashing implementation + mandatory SKILL.md — closes #316 (#319).
 *
 * ENGRAM-STANDARD-v1.md §5.5:  H = SHA256( bytes(SKILL.md) || bytes(engrams.yaml) )
 *
 * Knowledge packs MUST ship a SKILL.md; manifest.yaml is not a substitute. The
 * two hash helpers (computePackHash in packs.ts, computePackChecksum in trust.ts)
 * compute the identical hash — computePackChecksum delegates to computePackHash —
 * so they cannot diverge, and a manifest.yaml never enters the hash.
 */
describe('pack hash + mandatory SKILL.md (#316/#319)', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-packhash-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** SHA256 over the raw concatenation of the given file byte-strings. */
  const sha256 = (...parts: string[]) => {
    const h = crypto.createHash('sha256')
    for (const p of parts) h.update(Buffer.from(p))
    return h.digest('hex')
  }

  it('SKILL.md pack: checksum equals the hash (single implementation)', () => {
    writeFileSync(join(dir, 'SKILL.md'), '# Skill\nbody\n')
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')

    expect(computePackChecksum(dir)).toBe(computePackHash(dir))
  })

  it('hashes SKILL.md + engrams.yaml over raw bytes (no re-serialization)', () => {
    const skill = '# Skill\nbody\n'
    const engrams = 'engrams: []\n'
    writeFileSync(join(dir, 'SKILL.md'), skill)
    writeFileSync(join(dir, 'engrams.yaml'), engrams)

    expect(computePackChecksum(dir)).toBe(sha256(skill, engrams))
  })

  it('manifest.yaml does NOT contribute to the hash', () => {
    const skill = '# Skill\nbody\n'
    const engrams = 'engrams: []\n'
    writeFileSync(join(dir, 'SKILL.md'), skill)
    writeFileSync(join(dir, 'engrams.yaml'), engrams)
    const withoutManifest = computePackHash(dir)

    // Adding a manifest.yaml must not change the hash — only SKILL.md + engrams count.
    writeFileSync(join(dir, 'manifest.yaml'), 'name: ignored\nversion: 9\n')
    expect(computePackHash(dir)).toBe(withoutManifest)
    expect(computePackChecksum(dir)).toBe(withoutManifest)
  })

  it('SKILL.md only (no engrams) still hashes deterministically', () => {
    const skill = '# Skill only\n'
    writeFileSync(join(dir, 'SKILL.md'), skill)
    expect(computePackChecksum(dir)).toBe(sha256(skill))
    expect(computePackChecksum(dir)).toBe(computePackHash(dir))
  })

  it('empty pack dir (no SKILL.md, no engrams): checksum is null (contract preserved)', () => {
    expect(computePackChecksum(dir)).toBeNull()
  })

  it('loadPack REJECTS a manifest-only pack (SKILL.md is mandatory)', () => {
    // A manifest.yaml without a SKILL.md used to load; it must now be rejected.
    writeFileSync(join(dir, 'manifest.yaml'), 'name: demo\nversion: 1\n')
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    expect(() => loadPack(dir)).toThrow(/must ship a SKILL\.md/i)
  })

  it('verifyPackChecksum: valid against its own checksum, invalid otherwise', () => {
    writeFileSync(join(dir, 'SKILL.md'), '# Skill\n')
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')

    const checksum = computePackChecksum(dir)!
    expect(verifyPackChecksum(dir, checksum)).toEqual({ valid: true, actual: checksum })
    expect(verifyPackChecksum(dir, 'sha256:wrong')).toEqual({ valid: false, actual: checksum })
  })
})
