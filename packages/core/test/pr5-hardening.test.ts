/**
 * PR-5 (#353 audit) — low-severity hardening + missing coverage.
 *
 * Covers four findings on the core side:
 *  - LOW-1  saveMetaEngrams runs the leak guard before persist (HARD secret +
 *           SOFT infra demotion) — previously the one public persist method with
 *           NO scope-security stack.
 *  - LOW-2  _guardExplicitUpdate scans context fields (rationale/source/…), not
 *           just the statement.
 *  - LOW-9  learnAsync UPDATE/MERGE demotion stamps `structured_data._demoted`.
 *  - MED-20 learnAsync UPDATE/MERGE demotion is driven for REAL at a SHARED
 *           scope (not short-circuited by a personal target).
 *
 * Every demotion test uses a SHARED-scope fixture so `_offendingHitsForScope`
 * does NOT take the personal fast-path; a personal-scope boundary case proves
 * the demotion is the guard firing, not a test accident.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { vi } from 'vitest'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'

// A real-shape public droplet IPv4 — the exact class that leaked in 2026-06.
const PUBLIC_IP = '139.59.155.82'
const SHARED_SCOPE = 'group:plur/engineering'

const dirs: string[] = []
function freshPlur(extraConfig: Record<string, unknown> = {}): Plur {
  const dir = mkdtempSync(join(tmpdir(), 'plur-pr5-'))
  dirs.push(dir)
  // index:false keeps the test on the YAML path; a path-based SHARED store makes
  // the scope a real shared scope without standing up a remote.
  writeFileSync(
    join(dir, 'config.yaml'),
    yaml.dump({ stores: [{ scope: SHARED_SCOPE, shared: true, path: dir }], index: false, ...extraConfig }, { noRefs: true }),
  )
  return new Plur({ path: dir })
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

/** Build a mock dedup LLM that always returns the given decision + target id. */
function dedupLlm(decision: 'UPDATE' | 'MERGE', targetId: string) {
  return vi.fn().mockResolvedValue(
    `DECISION: ${decision}\nTARGET: ${targetId}\nCONFLICTS: none\nREASON: test-driven ${decision}`,
  )
}

describe('MED-20 + LOW-9 — learnAsync UPDATE/MERGE demotion (real guard, shared scope)', () => {
  it('UPDATE that introduces a public IP into a SHARED-scope engram demotes + stamps _demoted', async () => {
    const plur = freshPlur({ dedup: { enabled: true, mode: 'llm' } })
    // Seed a CLEAN engram at the shared scope (no demotion at creation).
    const seed = plur.learn('the deploy runbook lives in the wiki', { scope: SHARED_SCOPE, type: 'procedural' }) as Engram
    expect(seed.scope).toBe(SHARED_SCOPE)

    const llm = dedupLlm('UPDATE', seed.id)
    const result = await plur.learnAsync(`the deploy target is ${PUBLIC_IP}`, { llm })

    expect(llm).toHaveBeenCalled()
    expect(result.decision).toBe('UPDATE')
    const e = result.engram as Engram & { visibility?: string; structured_data?: { _demoted?: { from: string; to: string; patterns: string } } }
    // Real demotion: scope→local, visibility→private.
    expect(e.scope).toBe('local')
    expect(e.visibility).toBe('private')
    // LOW-9 marker stamped, mirroring the sync demotion sites.
    expect(e.structured_data?._demoted?.from).toBe(SHARED_SCOPE)
    expect(e.structured_data?._demoted?.to).toBe('local')
    expect(e.structured_data?._demoted?.patterns).toMatch(/public_ipv4/)
  }, 30_000)

  it('MERGE that introduces a public IP into a SHARED-scope engram demotes + stamps _demoted', async () => {
    const plur = freshPlur({ dedup: { enabled: true, mode: 'llm' } })
    const seed = plur.learn('the staging cluster is documented in the handbook', { scope: SHARED_SCOPE, type: 'procedural' }) as Engram

    const llm = dedupLlm('MERGE', seed.id)
    const result = await plur.learnAsync(`reachable at ${PUBLIC_IP}:8877`, { llm })

    expect(result.decision).toBe('MERGE')
    const e = result.engram as Engram & { visibility?: string; structured_data?: { _demoted?: { from: string; to: string; patterns: string } } }
    expect(e.scope).toBe('local')
    expect(e.visibility).toBe('private')
    expect(e.structured_data?._demoted?.from).toBe(SHARED_SCOPE)
    expect(e.structured_data?._demoted?.patterns).toMatch(/public_ipv4|ipv4_port/)
  }, 30_000)

  it('BOUNDARY: the SAME UPDATE into a PERSONAL (global) engram does NOT demote and does NOT stamp', async () => {
    const plur = freshPlur({ dedup: { enabled: true, mode: 'llm' } })
    // Personal scope — _offendingHitsForScope short-circuits (fast-path), so no demotion.
    const seed = plur.learn('the deploy runbook lives in the wiki', { scope: 'global', type: 'procedural' }) as Engram
    expect(seed.scope).toBe('global')

    const llm = dedupLlm('UPDATE', seed.id)
    const result = await plur.learnAsync(`the deploy target is ${PUBLIC_IP}`, { llm })

    expect(result.decision).toBe('UPDATE')
    const e = result.engram as Engram & { visibility?: string; structured_data?: { _demoted?: unknown } }
    // Stays at its personal scope — proves the demotion above was the
    // isSharedScope guard firing, not a test artifact.
    expect(e.scope).toBe('global')
    expect(e.structured_data?._demoted).toBeUndefined()
  }, 30_000)
})

describe('LOW-2 — _guardExplicitUpdate scans context fields', () => {
  it('demotes an explicit update when a public IP is ONLY in a context field (source) at a shared scope', () => {
    const plur = freshPlur()
    // Seed a clean engram at the shared scope.
    const seed = plur.learn('the canonical pack format is SKILL.md', { scope: SHARED_SCOPE, type: 'architectural' }) as Engram
    expect(seed.scope).toBe(SHARED_SCOPE)

    // Explicit update: statement stays clean, but a sensitive IP hides in `source`.
    const updated = { ...seed, source: `pulled from ${PUBLIC_IP}` } as Engram
    const ok = plur.updateEngram(updated)
    expect(ok).toBe(true)

    const after = plur.list().find(e => e.id === seed.id) as (Engram & { visibility?: string }) | undefined
    expect(after).toBeDefined()
    // Demoted in place because the context field carried the credential.
    expect(after!.scope).toBe('local')
    expect(after!.visibility).toBe('private')
  })

  it('does NOT demote a clean explicit update (no over-blocking)', () => {
    const plur = freshPlur()
    const seed = plur.learn('the canonical pack format is SKILL.md', { scope: SHARED_SCOPE, type: 'architectural' }) as Engram
    const updated = { ...seed, source: 'pulled from the team wiki', rationale: 'authoritative' } as Engram
    plur.updateEngram(updated)
    const after = plur.list().find(e => e.id === seed.id) as Engram | undefined
    expect(after!.scope).toBe(SHARED_SCOPE)
  })
})

describe('LOW-1 — saveMetaEngrams runs the leak guard before persist', () => {
  let metaSeq = 0
  /**
   * Build a schema-valid meta-engram by deriving it from a real `learn()`
   * engram on a throwaway Plur, then overriding fields. Hand-built engrams miss
   * required fields (version/content_hash/…) and are silently dropped on reload.
   */
  function meta(overrides: Partial<Engram> & { statement: string; scope: string }): Engram {
    const tmp = mkdtempSync(join(tmpdir(), 'plur-pr5-meta-'))
    dirs.push(tmp)
    writeFileSync(join(tmp, 'config.yaml'), yaml.dump({ stores: [], index: false }, { noRefs: true }))
    const base = new (Plur as unknown as { new (o: { path: string }): Plur })({ path: tmp })
      .learn('seed for meta shape', { scope: 'global' }) as Engram
    metaSeq += 1
    return {
      ...base,
      id: `ENG-2026-0620-9${String(metaSeq).padStart(2, '0')}`,
      visibility: 'private',
      ...overrides,
    } as Engram
  }

  it('demotes a SHARED-scope meta with a public IP (statement) to local/private + stamps _demoted', () => {
    const plur = freshPlur()
    const m = meta({ statement: `infra note: prod box ${PUBLIC_IP}`, scope: SHARED_SCOPE })
    const res = plur.saveMetaEngrams([m])
    expect(res.saved).toBe(1)
    const saved = plur.list().find(e => e.id === m.id) as (Engram & { visibility?: string; structured_data?: { _demoted?: { from: string; patterns: string } } }) | undefined
    expect(saved).toBeDefined()
    expect(saved!.scope).toBe('local')
    expect(saved!.visibility).toBe('private')
    expect(saved!.structured_data?._demoted?.from).toBe(SHARED_SCOPE)
    expect(saved!.structured_data?._demoted?.patterns).toMatch(/public_ipv4/)
  })

  it('demotes a SHARED-scope meta whose sensitive content is in a CONTEXT field (source)', () => {
    const plur = freshPlur()
    const m = meta({ statement: 'a clean meta statement', source: `seen at ${PUBLIC_IP}`, scope: SHARED_SCOPE })
    plur.saveMetaEngrams([m])
    const saved = plur.list().find(e => e.id === m.id) as (Engram & { visibility?: string }) | undefined
    expect(saved!.scope).toBe('local')
    expect(saved!.visibility).toBe('private')
  })

  it('THROWS on a raw secret in a SHARED-scope meta (HARD detectSecrets check)', () => {
    const plur = freshPlur()
    const m = meta({ statement: 'the api key is sk-aaaabbbbccccddddeeeeffffgggg', scope: SHARED_SCOPE })
    expect(() => plur.saveMetaEngrams([m])).toThrow(/secret detected/i)
  })

  it('leaves a clean PERSONAL-scope meta untouched (no-op for in-tree callers)', () => {
    const plur = freshPlur()
    const m = meta({ statement: 'a perfectly clean meta', scope: 'global' })
    const res = plur.saveMetaEngrams([m])
    expect(res.saved).toBe(1)
    const saved = plur.list().find(e => e.id === m.id) as (Engram & { structured_data?: { _demoted?: unknown } }) | undefined
    expect(saved!.scope).toBe('global')
    expect(saved!.structured_data?._demoted).toBeUndefined()
  })
})
