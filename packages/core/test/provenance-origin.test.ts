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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
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

// ── The defects the review found: attribution that never reached production ──

describe('#1048 review findings', () => {
  it('the constructor identity survives a config reload', async () => {
    // THE DEFECT: the override was merged INTO this.config, and the next
    // `this.config = loadConfig(...)` threw it away. _resolveUnscopedScope calls
    // reloadConfigIfChanged() on every unscoped learn(), so one config.yaml
    // mtime change reverted an explicitly configured identity to
    // "agent:unidentified" — silently, and it defeats the whole epic.
    const dir = mkdtempSync(join(tmpdir(), 'prov-reload-'))
    const p = new Plur({ storageRoot: dir, provenance: { identity: 'agent:ctor' } } as never)

    const first = await p.learn('a statement written before any reload', { type: 'behavioral' })
    expect((first as never as { provenance?: { origin?: string } }).provenance?.origin).toBe('agent:ctor')

    // Touch config.yaml so the next unscoped learn reloads it.
    const cfg = join(dir, 'config.yaml')
    writeFileSync(cfg, (existsSync(cfg) ? readFileSync(cfg, 'utf8') : '') + '\n# touched\n')

    const second = await p.learn('a statement written after the reload', { type: 'behavioral' })
    expect(
      (second as never as { provenance?: { origin?: string } }).provenance?.origin,
      'the constructor identity must survive loadConfig',
    ).toBe('agent:ctor')
    rmSync(dir, { recursive: true, force: true })
  })

  it('an empty session_id does not beat a real session_episode_id', async () => {
    // `??` let session_id: '' win and persist as the empty string, while
    // provenance fourteen lines away treated an empty identity as absent.
    const dir = mkdtempSync(join(tmpdir(), 'prov-empty-'))
    const p = new Plur({ storageRoot: dir } as never)
    const e = await p.learn('a statement with an empty session id', {
      type: 'behavioral', session_id: '', session_episode_id: 'EP-42',
    } as never)
    const sources = (e as never as { sources?: Array<{ session_id: string | null }> }).sources
    expect(sources?.[0].session_id).toBe('EP-42')
    rmSync(dir, { recursive: true, force: true })
  })

  it('the deprecated `session` alias still resolves scope AND now attributes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-alias-'))
    const p = new Plur({ storageRoot: dir } as never)
    const e = await p.learn('a statement using the deprecated alias', {
      type: 'behavioral', session: 'sess-legacy',
    } as never)
    const sources = (e as never as { sources?: Array<{ session_id: string | null }> }).sources
    expect(sources?.[0].session_id).toBe('sess-legacy')
    rmSync(dir, { recursive: true, force: true })
  })

  it('saveMetaEngrams does not persist an engram with no provenance', async () => {
    // formulateMetaEngram builds a complete engram with no provenance block,
    // and this public write path pushed it in verbatim.
    const dir = mkdtempSync(join(tmpdir(), 'prov-meta-'))
    const p = new Plur({ storageRoot: dir, provenance: { identity: 'agent:meta' } } as never)
    const meta = {
      id: 'ENG-META-001', statement: 'a meta engram', type: 'behavioral',
      scope: 'global', status: 'active',
      sources: [{ scope: 'global', session_id: null, stored_at: new Date().toISOString() }],
    } as never
    await p.saveMetaEngrams([meta])
    expect((meta as { provenance?: { origin?: string } }).provenance?.origin).toBe('agent:meta')
    rmSync(dir, { recursive: true, force: true })
  })
})

// ── The call sites, asserted as call sites ──────────────────────────────────

describe('#1048 is wired into the paths that actually write', () => {
  it('MCP, CLI and claw all pass session_id into LearnContext', async () => {
    // THE DEFECT THIS GUARDS: every unit test passed while
    // `sources[].session_id` was null on every shipping path, because the MCP
    // handler mapped args.session_id into `context.session` — a different field
    // — and the CLI and claw passed nothing at all. The field this change adds
    // had zero non-test callers. That is not a logic bug any unit test can see;
    // only an assertion about the call sites can.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join: j } = await import('node:path')
    const root = j(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

    const cases: Array<[string, RegExp]> = [
      ['packages/mcp/src/tools.ts', /session_id: _resolveInjectionSession\(args\)/],
      ['packages/cli/src/commands/learn.ts', /session_id: process\.env\.PLUR_SESSION_ID/],
      ['packages/claw/src/context-engine.ts', /session_id: sessionKey/],
    ]
    for (const [file, pattern] of cases) {
      const src = readFileSync(j(root, file), 'utf8')
      expect(src, `${file} must thread session_id into the learn context`).toMatch(pattern)
    }
  })

  it('plur_learn_batch attributes its writes too', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join: j } = await import('node:path')
    const root = j(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const src = readFileSync(j(root, 'packages/mcp/src/tools.ts'), 'utf8')
    // Two occurrences: the single-write handler and the batch handler.
    expect(src.match(/session_id: _resolveInjectionSession\(args\)/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2)
  })
})
