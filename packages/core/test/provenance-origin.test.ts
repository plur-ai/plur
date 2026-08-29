/**
 * Wave 1 — thread session_id + write provenance.origin on every engram write
 * Issue #1048 (part of #1047).
 *
 * Acceptance criteria:
 *   - A learn() inside a session writes both sources[].session_id and provenance.
 *   - No-identity path writes origin = 'agent:unidentified'.
 *   - LearnContext accepts a session_id field that feeds sources[].session_id.
 *   - session_id takes precedence over session_episode_id in the source entry.
 *   - Provenance block: origin, chain=[], signature=null, license='cc-by-sa-4.0'.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'plur-prov-'))
}

describe('Wave 1: session_id threading + provenance.origin (#1048)', () => {
  let dir: string

  beforeEach(() => { dir = tmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // ── LearnContext.session_id ────────────────────────────────────────────────

  describe('LearnContext.session_id field', () => {
    it('accepts session_id without TypeScript error and stores it in sources[0].session_id', async () => {
      const plur = new Plur({ path: dir })
      const sid = 'sess-abc-123'
      const engram = await plur.learn('test statement for session_id threading', {
        session_id: sid,
      })
      const source = (engram as any).sources?.[0]
      expect(source).toBeDefined()
      expect(source.session_id).toBe(sid)
    })

    it('prefers session_id over session_episode_id when both are supplied', async () => {
      const plur = new Plur({ path: dir })
      const engram = await plur.learn('session_id wins over session_episode_id', {
        session_id: 'primary-sess',
        session_episode_id: 'episode-fallback',
      })
      const source = (engram as any).sources?.[0]
      expect(source.session_id).toBe('primary-sess')
    })

    it('falls back to session_episode_id when session_id is absent', async () => {
      const plur = new Plur({ path: dir })
      const engram = await plur.learn('session_episode_id fallback path', {
        session_episode_id: 'ep-789',
      })
      const source = (engram as any).sources?.[0]
      expect(source.session_id).toBe('ep-789')
    })

    it('stores null when neither session_id nor session_episode_id is provided', async () => {
      const plur = new Plur({ path: dir })
      const engram = await plur.learn('no session context at all')
      const source = (engram as any).sources?.[0]
      expect(source.session_id).toBeNull()
    })
  })

  // ── provenance.origin — no-identity path ──────────────────────────────────

  describe('provenance.origin — no identity configured', () => {
    it('writes provenance.origin = "agent:unidentified" when config has no identity', async () => {
      const plur = new Plur({ path: dir })
      const engram = await plur.learn('provenance origin unidentified path')
      expect(engram.provenance).toBeDefined()
      expect(engram.provenance!.origin).toBe('agent:unidentified')
    })

    it('writes an empty chain []', async () => {
      const plur = new Plur({ path: dir })
      const engram = await plur.learn('provenance chain is empty by default')
      expect(engram.provenance!.chain).toEqual([])
    })

    it('writes signature = null', async () => {
      const plur = new Plur({ path: dir })
      const engram = await plur.learn('provenance signature is null placeholder')
      expect(engram.provenance!.signature).toBeNull()
    })

    it('writes license = "cc-by-sa-4.0"', async () => {
      const plur = new Plur({ path: dir })
      const engram = await plur.learn('provenance license is cc-by-sa-4.0')
      expect(engram.provenance!.license).toBe('cc-by-sa-4.0')
    })
  })

  // ── provenance.origin — identity configured ───────────────────────────────

  describe('provenance.origin — identity configured', () => {
    it('uses config.provenance.identity as origin when set', async () => {
      const plur = new Plur({
        path: dir,
        provenance: { identity: 'agent:claude-code' },
      })
      const engram = await plur.learn('provenance with configured identity')
      expect(engram.provenance!.origin).toBe('agent:claude-code')
    })

    it('falls back to "agent:unidentified" when provenance key exists but identity is absent', async () => {
      const plur = new Plur({
        path: dir,
        provenance: {} as any,
      })
      const engram = await plur.learn('provenance block present but identity missing')
      expect(engram.provenance!.origin).toBe('agent:unidentified')
    })
  })

  // ── learnRouted / _buildEngramShape path ──────────────────────────────────

  describe('_buildEngramShape (learnRouted path)', () => {
    it('sets provenance on the shaped engram returned by learnRouted', async () => {
      const plur = new Plur({
        path: dir,
        provenance: { identity: 'agent:nightshift' },
      })
      const result = await plur.learnRouted('learnRouted provenance test', {
        session_id: 'route-sess-1',
        domain: 'plur.test',
      })
      expect(result.provenance).toBeDefined()
      expect(result.provenance!.origin).toBe('agent:nightshift')
      const source = (result as any).sources?.[0]
      expect(source.session_id).toBe('route-sess-1')
    })
  })

  // ── YAML round-trip ───────────────────────────────────────────────────────

  describe('YAML round-trip', () => {
    it('provenance and sources[].session_id survive a save/reload cycle', async () => {
      const plur = new Plur({
        path: dir,
        provenance: { identity: 'agent:test' },
      })
      const written = await plur.learn('yaml round-trip for provenance', {
        session_id: 'round-trip-sess',
      })

      // Reload from disk
      const plur2 = new Plur({ path: dir })
      const reloaded = await plur2.getById(written.id)

      expect(reloaded).toBeDefined()
      expect(reloaded!.provenance?.origin).toBe('agent:test')
      const source = (reloaded as any).sources?.[0]
      expect(source.session_id).toBe('round-trip-sess')
    })
  })
})
