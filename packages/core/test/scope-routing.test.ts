/**
 * Deterministic scope-suggestion ranker (#345/#346, Stage 3a). Two surfaces:
 *
 *  1. rankScopes() — the pure helper. No Plur instance, no config, no I/O:
 *     signals + scope metadata in, ranked candidates out. Proves the scoring
 *     channels (domain-prefix ≫ tag > keyword), normalization into [0,1], and
 *     the deterministic scope-name tie-break.
 *
 *  2. plur.suggestScope() — the Plur method, fed from config `stores` entries
 *     that carry `covers`, mirroring scope-metadata.test.ts's plurWithStores
 *     helper. Proves the method reads metadata the same way getScopeMetadata
 *     does, and — crucially — that it is ADVISORY: it never routes or stores.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, rankScopes, SCOPE_MATCH_THRESHOLD } from '../src/index.js'

describe('rankScopes — pure ranker', () => {
  const SCOPES = [
    { scope: 'group:plur/core', covers: ['plur.*', 'engine', 'embeddings'] },
    { scope: 'group:plur/infra', covers: ['infra', 'deployment', 'servers'] },
    { scope: 'group:plur/docs', covers: ['documentation', 'guides'] },
  ]

  it('ranks a domain-prefix match at the top, above tag/keyword-only matches', () => {
    const ranked = rankScopes(
      { statement: 'the secret rotation policy', domain: 'plur.core.security', tags: ['servers'] },
      SCOPES,
    )
    expect(ranked.length).toBeGreaterThanOrEqual(2)
    // core wins on the domain-prefix hit (plur.core.security ⊂ plur.*)…
    expect(ranked[0].scope).toBe('group:plur/core')
    // …above infra, which only got a tag hit (servers).
    expect(ranked[0].confidence).toBeGreaterThan(ranked[1].confidence)
    expect(ranked.find(c => c.scope === 'group:plur/infra')).toBeDefined()
    expect(ranked[0].reason).toContain('domain plur.core.security')
    expect(ranked[0].reason).toContain('plur.*')
  })

  it('ranks a tag-only match below a domain match', () => {
    const ranked = rankScopes(
      { statement: 'no overlapping words here xyz', domain: 'plur.core.fts', tags: ['deployment'] },
      SCOPES,
    )
    const core = ranked.find(c => c.scope === 'group:plur/core')!  // domain hit
    const infra = ranked.find(c => c.scope === 'group:plur/infra')! // tag hit only
    expect(core).toBeDefined()
    expect(infra).toBeDefined()
    expect(core.confidence).toBeGreaterThan(infra.confidence)
  })

  it('scores keyword-only matches lowest and still includes them', () => {
    const ranked = rankScopes(
      { statement: 'updating the deployment runbook for servers' },
      SCOPES,
    )
    // Only infra's cover tokens (deployment, servers) appear in the statement.
    expect(ranked.map(c => c.scope)).toContain('group:plur/infra')
    const infra = ranked.find(c => c.scope === 'group:plur/infra')!
    expect(infra.confidence).toBeGreaterThan(0)
    // Keyword-only is weak — well under a domain-prefix match's confidence.
    expect(infra.confidence).toBeLessThan(0.5)
    expect(infra.reason).toContain('keywords')
  })

  it('returns an empty array when nothing matches', () => {
    expect(rankScopes({ statement: 'completely unrelated content zzz' }, SCOPES)).toEqual([])
    expect(rankScopes({ statement: 'anything', domain: 'other.namespace' }, SCOPES)).toEqual([])
  })

  it('omits scopes that declare no covers', () => {
    const ranked = rankScopes(
      { statement: 'engine internals', domain: 'plur.core' },
      [
        { scope: 'group:plur/core', covers: ['plur.*'] },
        { scope: 'group:plur/empty', covers: [] },
        { scope: 'group:plur/nocovers', covers: undefined as unknown as string[] },
      ],
    )
    expect(ranked.map(c => c.scope)).toEqual(['group:plur/core'])
  })

  it('keeps every confidence in [0,1]', () => {
    const ranked = rankScopes(
      { statement: 'plur engine embeddings deployment servers infra', domain: 'plur.core.x', tags: ['infra', 'servers', 'deployment'] },
      SCOPES,
    )
    expect(ranked.length).toBeGreaterThan(0)
    for (const c of ranked) {
      expect(c.confidence).toBeGreaterThan(0)
      expect(c.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('breaks ties deterministically on scope name (ascending)', () => {
    // Two scopes that match identically (same single tag hit) → equal score.
    // Tie-break must order them by scope name, and be stable across input order.
    const a = { scope: 'group:plur/aaa', covers: ['shared'] }
    const b = { scope: 'group:plur/bbb', covers: ['shared'] }
    const signals = { statement: 'irrelevant', tags: ['shared'] }
    const forward = rankScopes(signals, [a, b])
    const reversed = rankScopes(signals, [b, a])
    expect(forward[0].confidence).toBe(forward[1].confidence) // genuinely tied
    expect(forward.map(c => c.scope)).toEqual(['group:plur/aaa', 'group:plur/bbb'])
    expect(reversed.map(c => c.scope)).toEqual(['group:plur/aaa', 'group:plur/bbb'])
  })

  it('treats a bare prefix and a trailing-".*" cover identically', () => {
    const glob = rankScopes({ statement: 'x', domain: 'plur.core.security' }, [{ scope: 's', covers: ['plur.*'] }])
    const bare = rankScopes({ statement: 'x', domain: 'plur.core.security' }, [{ scope: 's', covers: ['plur'] }])
    expect(glob[0].confidence).toBe(bare[0].confidence)
  })

  it('does NOT match across a namespace segment boundary', () => {
    // `plurple` must not match the `plur` namespace prefix (segment, not substring).
    const ranked = rankScopes({ statement: 'x', domain: 'plurple.thing' }, [{ scope: 's', covers: ['plur'] }])
    expect(ranked).toEqual([])
  })

  it('exports a routing threshold constant for Stage 3b (not applied here)', () => {
    expect(SCOPE_MATCH_THRESHOLD).toBeGreaterThan(0)
    expect(SCOPE_MATCH_THRESHOLD).toBeLessThan(1)
  })
})

describe('plur.suggestScope — reads scope metadata from config stores', () => {
  const dirs: string[] = []
  /** Build a Plur whose config carries the given store entries (with covers). */
  const plurWithStores = (stores: unknown[], extra: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-scope-route-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores, index: false, ...extra }, { noRefs: true }))
    return new Plur({ path: dir })
  }
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

  it('ranks registered scopes by fit', () => {
    const plur = plurWithStores([
      { path: '/tmp/core.yaml', scope: 'group:plur/core', description: 'Core engine', covers: ['plur.*', 'engine'] },
      { path: '/tmp/infra.yaml', scope: 'group:plur/infra', description: 'Infra', covers: ['servers', 'deployment'] },
    ])
    const ranked = plur.suggestScope({ statement: 'embedding model init', domain: 'plur.core.embeddings' })
    expect(ranked[0].scope).toBe('group:plur/core')
    expect(ranked[0].confidence).toBeGreaterThan(0)
  })

  it('returns an empty array when no registered scope declares covers', () => {
    const plur = plurWithStores([
      { path: '/tmp/x.yaml', scope: 'group:plur/x', description: 'No covers declared' },
    ])
    expect(plur.suggestScope({ statement: 'anything at all', domain: 'plur.core' })).toEqual([])
  })

  it('returns an empty array with no stores configured', () => {
    const plur = plurWithStores([])
    expect(plur.suggestScope({ statement: 'whatever', tags: ['infra'] })).toEqual([])
  })

  it('Stage 3b: a weak (sub-threshold) match falls to unscoped_default, NOT the top suggestion', () => {
    const plur = plurWithStores([
      { path: '/tmp/infra.yaml', scope: 'group:plur/infra', description: 'Infra', covers: ['servers', 'deployment'] },
    ])
    // suggestScope still points at the infra scope (advisory ranking unchanged)…
    const ranked = plur.suggestScope({ statement: 'restart the deployment on the servers' })
    expect(ranked[0].scope).toBe('group:plur/infra')
    // …but its confidence is only a keyword match (deployment + servers), which
    // sits BELOW SCOPE_MATCH_THRESHOLD, so Stage 3b auto-routing does NOT fire —
    // the unscoped write falls to unscoped_default ('global' by default, reverted
    // in 0.10.0 #353). The confident (domain-prefix) auto-route path is covered
    // in route-unscoped.test.ts.
    expect(ranked[0].confidence).toBeLessThan(SCOPE_MATCH_THRESHOLD)
    const e = plur.learn('restart the deployment on the servers') as { scope: string }
    expect(e.scope).toBe('global')
  })

  it('feeds tags through to the ranker', () => {
    const plur = plurWithStores([
      { path: '/tmp/infra.yaml', scope: 'group:plur/infra', description: 'Infra', covers: ['servers'] },
    ])
    const ranked = plur.suggestScope({ statement: 'no overlap words zzz', tags: ['servers'] })
    expect(ranked.map(c => c.scope)).toContain('group:plur/infra')
  })
})
