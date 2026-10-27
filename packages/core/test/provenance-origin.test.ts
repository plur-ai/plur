/**
 * Wave 1 — thread session_id + write provenance.origin on every engram write
 * Issue #1048 (part of #1047).
 *
 * Acceptance criteria, as rebased onto main (2026-10-27):
 *   - LearnContext accepts a session_id field that feeds sources[].session_id.
 *   - session_id takes precedence over session_episode_id in the source entry.
 *   - The writer's identity is recorded in `attribution.asserted_by` (#961),
 *     which main built after this branch was cut; the unidentified marker when
 *     none is configured. The branch's own answer — `provenance.origin` set to
 *     the identity, with a `cc-by-sa-4.0` licence on every engram — is gone:
 *     main records a licence only when somebody chose one (#970), and its
 *     provenance block appears only when it has content.
 *   - `session` (which selects the default scope and can hold an internal
 *     registry key) is never recorded as a session id.
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

  describe('attribution — no identity configured', () => {
    it('records the unidentified marker as asserted_by', async () => {
      const plur = new Plur({ path: dir })
      const engram = await plur.learn('attribution unidentified path')
      expect(engram.attribution?.asserted_by).toBe('unidentified')
    })

    it('writes no default licence', async () => {
      const plur = new Plur({ path: dir })
      const engram = await plur.learn('no licence nobody chose')
      expect(engram.provenance?.license).toBeUndefined()
    })
  })

  describe('attribution — identity configured', () => {
    it('uses config.provenance.identity as asserted_by when set', async () => {
      writeFileSync(join(dir, 'config.yaml'), 'provenance:\n  identity: agent:claude-code\n')
      const plur = new Plur({ path: dir })
      const engram = await plur.learn('attribution with configured identity')
      expect(engram.attribution?.asserted_by).toBe('agent:claude-code')
    })
  })

  describe('_buildEngramShape (learnRouted path)', () => {
    it('records attribution and session_id on the shaped engram returned by learnRouted', async () => {
      writeFileSync(join(dir, 'config.yaml'), 'provenance:\n  identity: agent:nightshift\n')
      const plur = new Plur({ path: dir })
      const result = await plur.learnRouted('learnRouted provenance test', {
        session_id: 'route-sess-1',
        domain: 'plur.test',
      })
      expect(result.attribution?.asserted_by).toBe('agent:nightshift')
      const source = (result as any).sources?.[0]
      expect(source.session_id).toBe('route-sess-1')
    })
  })

  // ── YAML round-trip ───────────────────────────────────────────────────────

  describe('YAML round-trip', () => {
    it('attribution and sources[].session_id survive a save/reload cycle', async () => {
      writeFileSync(join(dir, 'config.yaml'), 'provenance:\n  identity: agent:test\n')
      const plur = new Plur({ path: dir })
      const written = await plur.learn('yaml round-trip for provenance', {
        session_id: 'round-trip-sess',
      })

      // Reload from disk
      const plur2 = new Plur({ path: dir })
      const reloaded = await plur2.getById(written.id)

      expect(reloaded).toBeDefined()
      expect(reloaded!.attribution?.asserted_by).toBe('agent:test')
      const source = (reloaded as any).sources?.[0]
      expect(source.session_id).toBe('round-trip-sess')
    })
  })
})

// ── The defects the review found: attribution that never reached production ──

describe('#1048 review findings', () => {
  it('the configured identity survives a config reload', async () => {
    // Main reads the identity from config.yaml (`provenance.identity`); the
    // branch's constructor override is not carried over. What must hold is
    // that a reload (any config.yaml mtime change) keeps it.
    const dir = mkdtempSync(join(tmpdir(), 'prov-reload-'))
    const cfg = join(dir, 'config.yaml')
    writeFileSync(cfg, 'provenance:\n  identity: agent:ctor\n')
    const p = new Plur({ path: dir } as never)

    const first = await p.learn('a statement written before any reload', { type: 'behavioral' })
    expect((first as never as { attribution?: { asserted_by?: string } }).attribution?.asserted_by).toBe('agent:ctor')

    writeFileSync(cfg, readFileSync(cfg, 'utf8') + '\n# touched\n')

    const second = await p.learn('a statement written after the reload', { type: 'behavioral' })
    expect(
      (second as never as { attribution?: { asserted_by?: string } }).attribution?.asserted_by,
      'the configured identity must survive loadConfig',
    ).toBe('agent:ctor')
    rmSync(dir, { recursive: true, force: true })
  })

  it('an empty session_id does not beat a real session_episode_id', async () => {
    // `??` let session_id: '' win and persist as the empty string, while
    // provenance fourteen lines away treated an empty identity as absent.
    const dir = mkdtempSync(join(tmpdir(), 'prov-empty-'))
    const p = new Plur({ path: dir } as never)
    const e = await p.learn('a statement with an empty session id', {
      type: 'behavioral', session_id: '', session_episode_id: 'EP-42',
    } as never)
    const sources = (e as never as { sources?: Array<{ session_id: string | null }> }).sources
    expect(sources?.[0].session_id).toBe('EP-42')
    rmSync(dir, { recursive: true, force: true })
  })

  it('`session` selects a scope and is never recorded as the session id', async () => {
    // On main, `session` can hold an internal registry key or NO_SESSION
    // (#1562, decision E7); writing it into sources[] would publish a value
    // that names no session.
    const dir = mkdtempSync(join(tmpdir(), 'prov-alias-'))
    const p = new Plur({ path: dir } as never)
    const e = await p.learn('a statement using only the scope selector', {
      type: 'behavioral', session: 'sess-legacy',
    } as never)
    const sources = (e as never as { sources?: Array<{ session_id: string | null }> }).sources
    expect(sources?.[0].session_id).toBeNull()
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
