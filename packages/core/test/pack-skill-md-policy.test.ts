import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import * as crypto from 'crypto'
import { computePackHash, installPack } from '../src/packs.js'
import { computePackChecksum, verifyPackChecksum } from '../src/trust.js'
import { loadPack } from '../src/engrams.js'

/**
 * Require a valid SKILL.md; deprecate manifest.yaml with auto-upgrade — #325.
 *
 * SKILL.md is the canonical pack manifest. manifest.yaml is deprecated: it still
 * loads (with a warning) and installPack auto-upgrades the installed copy to
 * SKILL.md. The §5.5 hash is SHA256(SKILL.md || engrams.yaml) — manifest.yaml
 * never enters it — and computePackChecksum delegates to computePackHash so the
 * two helpers cannot diverge (#316).
 */
describe('pack SKILL.md policy + manifest.yaml deprecation (#325)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-skillmd-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const sha256 = (...parts: string[]) => {
    const h = crypto.createHash('sha256')
    for (const p of parts) h.update(Buffer.from(p))
    return h.digest('hex')
  }
  const skillMd = (name = 'demo', version = '1.0.0') =>
    `---\nname: ${name}\nversion: ${version}\n---\n\n# ${name}\n\nA demo pack.\n`
  const validEngrams = [
    'engrams:',
    '  - id: ENG-0001',
    '    version: 2',
    '    status: active',
    '    type: behavioral',
    '    scope: global',
    '    statement: test engram from pack',
    '    activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: "2024-01-01" }',
    '    feedback_signals: { positive: 0, negative: 0, neutral: 0 }',
  ].join('\n') + '\n'

  describe('hashing', () => {
    it('checksum equals hash (single implementation) over SKILL.md + engrams.yaml', () => {
      const s = skillMd(); const e = validEngrams
      writeFileSync(join(dir, 'SKILL.md'), s)
      writeFileSync(join(dir, 'engrams.yaml'), e)
      expect(computePackChecksum(dir)).toBe(computePackHash(dir))
      expect(computePackChecksum(dir)).toBe(sha256(s, e))
    })

    it('manifest.yaml does NOT contribute to the hash', () => {
      writeFileSync(join(dir, 'SKILL.md'), skillMd())
      writeFileSync(join(dir, 'engrams.yaml'), validEngrams)
      const before = computePackHash(dir)
      writeFileSync(join(dir, 'manifest.yaml'), 'name: ignored\nversion: 9\n')
      expect(computePackHash(dir)).toBe(before)
    })

    it('null-on-empty contract preserved', () => {
      expect(computePackChecksum(dir)).toBeNull()
    })

    it('verifyPackChecksum round-trips', () => {
      writeFileSync(join(dir, 'SKILL.md'), skillMd())
      writeFileSync(join(dir, 'engrams.yaml'), validEngrams)
      const c = computePackChecksum(dir)!
      expect(verifyPackChecksum(dir, c)).toEqual({ valid: true, actual: c })
      expect(verifyPackChecksum(dir, 'sha256:wrong')).toEqual({ valid: false, actual: c })
    })
  })

  describe('loadPack manifest validation', () => {
    it('loads a SKILL.md pack', () => {
      writeFileSync(join(dir, 'SKILL.md'), skillMd('my-pack', '2.1.0'))
      writeFileSync(join(dir, 'engrams.yaml'), validEngrams)
      const pack = loadPack(dir)
      expect(pack.manifest.name).toBe('my-pack')
      expect(pack.manifest.version).toBe('2.1.0')
      expect(pack.engrams).toHaveLength(1)
    })

    it('LOADS a manifest.yaml-only pack (deprecated, not rejected)', () => {
      writeFileSync(join(dir, 'manifest.yaml'), 'name: legacy\nversion: 1.0.0\n')
      writeFileSync(join(dir, 'engrams.yaml'), validEngrams)
      expect(() => loadPack(dir)).not.toThrow()
      expect(loadPack(dir).manifest.name).toBe('legacy')
    })

    it('rejects a SKILL.md with no frontmatter (empty manifest)', () => {
      writeFileSync(join(dir, 'SKILL.md'), '# Just a heading, no frontmatter\n')
      writeFileSync(join(dir, 'engrams.yaml'), validEngrams)
      expect(() => loadPack(dir)).toThrow(/frontmatter/i)
    })

    it('rejects a SKILL.md whose frontmatter fails manifest validation (missing version)', () => {
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: incomplete\n---\n\n# incomplete\n')
      writeFileSync(join(dir, 'engrams.yaml'), validEngrams)
      expect(() => loadPack(dir)).toThrow(/failed validation|version/i)
    })

    it('rejects a pack with neither SKILL.md nor manifest.yaml', () => {
      writeFileSync(join(dir, 'engrams.yaml'), validEngrams)
      expect(() => loadPack(dir)).toThrow(/must ship a SKILL\.md/i)
    })
  })

  describe('installPack auto-upgrade', () => {
    it('upgrades a manifest.yaml-only pack to SKILL.md in the installed copy', () => {
      const source = mkdtempSync(join(tmpdir(), 'plur-src-'))
      const packsDir = join(dir, 'packs')
      try {
        writeFileSync(join(source, 'manifest.yaml'), 'name: legacy-pack\nversion: 1.0.0\n')
        writeFileSync(join(source, 'engrams.yaml'), validEngrams)

        const result = installPack(packsDir, source)
        expect(result.installed).toBe(1)

        // installPack names the installed dir after the source basename.
        const dest = join(packsDir, basename(source))
        expect(existsSync(join(dest, 'SKILL.md'))).toBe(true)
        expect(existsSync(join(dest, 'manifest.yaml'))).toBe(false)
        // The upgraded SKILL.md re-parses to the same manifest.
        expect(loadPack(dest).manifest.name).toBe('legacy-pack')
        // Integrity recorded over SKILL.md + engrams.yaml.
        expect(result.registry.integrity).toBe(`sha256:${computePackHash(dest)}`)
      } finally {
        rmSync(source, { recursive: true, force: true })
      }
    })
  })
})
