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
import { Plur, rankScopes, SCOPE_MATCH_THRESHOLD, isSharedScope } from '../src/index.js'
import { THRESHOLD_SINGLE_DOMAIN } from '../src/scope-routing.js'

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

  // --- PR-6 (#353): expose `domainMatch` on each candidate so the write-path
  // router can route a FULL domain-prefix match deterministically. Additive —
  // `confidence`/`reason` are unchanged; only the new boolean is asserted here.
  it('flags `domainMatch:true` on a full domain-prefix candidate (cover ⊃ domain)', () => {
    const ranked = rankScopes(
      { statement: 'xyzzy nonoverlapping tokens', domain: 'plur.core.security' },
      [{ scope: 'group:plur/core', covers: ['plur.*'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].domainMatch).toBe(true)
  })

  it('flags `domainMatch:true` in the reverse direction (domain ⊃ cover)', () => {
    // domain `plur` is a prefix of cover `plur.core` — still a domain-channel hit.
    const ranked = rankScopes(
      { statement: 'zzz no overlap', domain: 'plur' },
      [{ scope: 'group:plur/core', covers: ['plur.core'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].domainMatch).toBe(true)
  })

  // --- R2-C (reaudit finding 4): `coverContainsDomain` distinguishes the two
  // domain-prefix directions. Only the FORWARD direction (cover ⊃ domain or
  // cover === domain) sets it; the caller keys the deterministic auto-route
  // bypass on it so a broad engram never lands in a narrow shared scope. ---
  it('R2-C: FORWARD direction (cover ⊃ domain) sets coverContainsDomain:true', () => {
    const ranked = rankScopes(
      { statement: 'xyzzy nonoverlapping tokens', domain: 'plur.core.security' },
      [{ scope: 'group:plur/core', covers: ['plur.*'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].domainMatch).toBe(true)
    expect(ranked[0].coverContainsDomain).toBe(true)
  })

  it('R2-C: EXACT match (cover === domain) sets coverContainsDomain:true', () => {
    const ranked = rankScopes(
      { statement: 'zzz no overlap', domain: 'plur.core' },
      [{ scope: 'group:plur/core', covers: ['plur.core'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].coverContainsDomain).toBe(true)
  })

  it('R2-C: REVERSE direction (domain ⊃ cover) leaves coverContainsDomain:false and is down-weighted below threshold', () => {
    // domain `plur` is BROADER than cover `plur.core`. domainMatch is true (for
    // scoring/ordering) but coverContainsDomain is false (no deterministic bypass),
    // and the lone reverse hit squashes to squash(WEIGHT_DOMAIN_REVERSE=0.5)=0.25,
    // BELOW SCOPE_MATCH_THRESHOLD — so a broad engram does not even clear the `>=`
    // gate on the reverse match alone.
    const ranked = rankScopes(
      { statement: 'zzz no overlap', domain: 'plur' },
      [{ scope: 'group:plur/core', covers: ['plur.core'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].domainMatch).toBe(true)
    expect(ranked[0].coverContainsDomain).toBe(false)
    expect(ranked[0].confidence).toBeCloseTo(0.25, 4)
    expect(ranked[0].confidence).toBeLessThan(SCOPE_MATCH_THRESHOLD)
  })

  it('R2-C: tag-only and keyword-only candidates leave coverContainsDomain:false', () => {
    const tagOnly = rankScopes(
      { statement: 'no overlap zzz', tags: ['servers'] },
      [{ scope: 'group:plur/infra', covers: ['servers'] }],
    )
    expect(tagOnly[0].coverContainsDomain).toBe(false)
    const kwOnly = rankScopes(
      { statement: 'updating the deployment runbook for servers' },
      [{ scope: 'group:plur/infra', covers: ['deployment', 'servers'] }],
    )
    expect(kwOnly[0].coverContainsDomain).toBe(false)
  })

  it('leaves `domainMatch:false` on a tag-only candidate', () => {
    const ranked = rankScopes(
      { statement: 'no overlap zzz', tags: ['servers', 'deploy', 'infra'] },
      [{ scope: 'group:plur/infra', covers: ['servers', 'deploy', 'infra'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].domainMatch).toBe(false)
  })

  it('leaves `domainMatch:false` on a keyword-only candidate', () => {
    const ranked = rankScopes(
      { statement: 'updating the deployment runbook for servers' },
      [{ scope: 'group:plur/infra', covers: ['deployment', 'servers'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].domainMatch).toBe(false)
  })

  it('on an EQUAL-confidence tie, ranks the domain-match candidate first', () => {
    // A lone domain hit (group:zzz-core: domain ⊂ covers) and a three-tag hit
    // (group:aaa-tags) BOTH squash to exactly 0.5. The domain candidate has the
    // alphabetically-later scope name, so the old name-only tie-break would have
    // put the tag candidate first; PR-6's domain-preferring tie-break must put
    // the genuine domain match at the top so the deterministic router picks it.
    const ranked = rankScopes(
      { statement: 'no overlap zzz', domain: 'plur.core.x', tags: ['servers', 'deploy', 'infra'] },
      [
        { scope: 'group:aaa-tags', covers: ['servers', 'deploy', 'infra'] }, // 3 tags → 0.5
        { scope: 'group:zzz-core', covers: ['plur.*'] },                     // domain → 0.5
      ],
    )
    expect(ranked[0].confidence).toBe(ranked[1].confidence) // genuinely tied at 0.5
    expect(ranked[0].scope).toBe('group:zzz-core')          // domain wins the tie
    expect(ranked[0].domainMatch).toBe(true)
    expect(ranked[1].domainMatch).toBe(false)
  })
})

describe('squash math — auto-route boundaries (#353 finding-11)', () => {
  // squash(raw) = raw / (raw + SATURATION), SATURATION = 1.5.
  // WEIGHT_DOMAIN = 1.5, WEIGHT_TAG = 0.5, WEIGHT_KEYWORD = 0.2.
  // The auto-route gate (index.ts `_resolveUnscopedScope`) is `>=`, so a
  // confidence landing EXACTLY on SCOPE_MATCH_THRESHOLD (0.5) clears it.

  it('THRESHOLD_SINGLE_DOMAIN === SCOPE_MATCH_THRESHOLD (exact in IEEE-754)', () => {
    // THRESHOLD_SINGLE_DOMAIN = WEIGHT_DOMAIN/(WEIGHT_DOMAIN+SATURATION)
    //                         = 1.5/3.0 = 0.5 — exactly representable, so the
    // derived constant equals the threshold by `===`, not by epsilon. If a future
    // weight/saturation tweak shifts it off 0.5 this assertion fails CI, flagging
    // a silent re-break of finding #11.
    expect(THRESHOLD_SINGLE_DOMAIN).toBe(SCOPE_MATCH_THRESHOLD)
    expect(THRESHOLD_SINGLE_DOMAIN).toBe(0.5)
  })

  it('a LONE domain-prefix match scores exactly 0.5 (clears the >= gate)', () => {
    // Only a domain hit, no tag, no keyword overlap → raw = WEIGHT_DOMAIN = 1.5.
    // squash(1.5) = 1.5/(1.5+1.5) = 0.5000.
    const ranked = rankScopes(
      { statement: 'xyzzy nonoverlapping tokens', domain: 'plur.core.security' },
      [{ scope: 'group:plur/core', covers: ['plur.*'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].confidence).toBe(0.5)
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(SCOPE_MATCH_THRESHOLD)
  })

  it('a LONE weak keyword match stays well below threshold', () => {
    // One keyword hit → raw = WEIGHT_KEYWORD = 0.2. squash(0.2)=0.2/1.7=0.1176.
    const ranked = rankScopes(
      { statement: 'embeddings' },
      [{ scope: 'group:plur/core', covers: ['embeddings'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].confidence).toBeCloseTo(0.1176, 4)
    expect(ranked[0].confidence).toBeLessThan(SCOPE_MATCH_THRESHOLD)
  })

  it('FIVE keyword-only hits still do NOT auto-route', () => {
    // 5 keyword hits → raw = 5*0.2 = 1.0. squash(1.0)=1.0/2.5=0.40 < 0.5.
    // Preserves "domain >> keyword": no pile of weak keywords out-routes one domain.
    const ranked = rankScopes(
      { statement: 'alpha beta gamma delta epsilon' },
      [{ scope: 'group:plur/x', covers: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].confidence).toBeCloseTo(0.4, 4)
    expect(ranked[0].confidence).toBeLessThan(SCOPE_MATCH_THRESHOLD)
  })

  it('ONE tag-only hit does NOT auto-route', () => {
    // 1 tag hit → raw = WEIGHT_TAG = 0.5. squash(0.5)=0.5/2.0=0.25 < 0.5.
    const ranked = rankScopes(
      { statement: 'no overlap zzz', tags: ['servers'] },
      [{ scope: 'group:plur/infra', covers: ['servers'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].confidence).toBeCloseTo(0.25, 4)
    expect(ranked[0].confidence).toBeLessThan(SCOPE_MATCH_THRESHOLD)
  })

  it('TWO matching tags do NOT auto-route (0.40 < 0.5)', () => {
    // 2 tag hits → raw = 2*0.5 = 1.0. squash(1.0)=0.40 < 0.5.
    const ranked = rankScopes(
      { statement: 'no overlap zzz', tags: ['servers', 'deploy'] },
      [{ scope: 'group:plur/infra', covers: ['servers', 'deploy'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].confidence).toBeCloseTo(0.4, 4)
    expect(ranked[0].confidence).toBeLessThan(SCOPE_MATCH_THRESHOLD)
  })

  it('THREE matching tags DO auto-route (0.50 — documented side effect)', () => {
    // 3 tag hits → raw = 3*0.5 = 1.5. squash(1.5)=0.50 exactly clears `>=`.
    // INTENT: three deliberate tag matches reaching threshold is acceptable and
    // intended (mirrors lone-domain). See WEIGHT_TAG comment in scope-routing.ts.
    const ranked = rankScopes(
      { statement: 'no overlap zzz', tags: ['servers', 'deploy', 'infra'] },
      [{ scope: 'group:plur/infra', covers: ['servers', 'deploy', 'infra'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].confidence).toBe(0.5)
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(SCOPE_MATCH_THRESHOLD)
  })

  it('FOUR matching tags auto-route (forward-proof, 0.571 > 0.5)', () => {
    // 4 tag hits → raw = 4*0.5 = 2.0. squash(2.0)=2.0/3.5=0.5714 > 0.5.
    const ranked = rankScopes(
      { statement: 'no overlap zzz', tags: ['servers', 'deploy', 'infra', 'ops'] },
      [{ scope: 'group:plur/infra', covers: ['servers', 'deploy', 'infra', 'ops'] }],
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].confidence).toBeCloseTo(0.5714, 4)
    expect(ranked[0].confidence).toBeGreaterThan(SCOPE_MATCH_THRESHOLD)
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

describe('rankScopes — keyword-only cap (#395)', () => {
  it('keyword-only overlap, however many tokens, does NOT clear the auto-route threshold', () => {
    // A cover with many single-word namespaces; a statement that matches 9 of them
    // but carries NO domain and NO tag — pure word-coincidence.
    const scope = { scope: 'group:acme/eng', covers: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'] }
    const ranked = rankScopes(
      { statement: 'alpha bravo charlie delta echo foxtrot golf hotel india miscellaneous notes' },
      [scope],
    )
    expect(ranked).toHaveLength(1)
    // Without the cap, 9*0.2 = 1.8 ⟹ squash ≈ 0.545 ≥ 0.5 would auto-route. Capped, it stays below.
    expect(ranked[0].confidence).toBeLessThan(SCOPE_MATCH_THRESHOLD)
  })

  it('keywords still boost a real domain match (the cap does not suppress them entirely)', () => {
    const scope = { scope: 'group:acme/eng', covers: ['acme.eng', 'alpha', 'bravo', 'charlie'] }
    const domainOnly = rankScopes({ statement: 'x', domain: 'acme.eng.api' }, [scope])[0]
    const domainPlusKeywords = rankScopes({ statement: 'alpha bravo charlie', domain: 'acme.eng.api' }, [scope])[0]
    expect(domainPlusKeywords.confidence).toBeGreaterThan(domainOnly.confidence)
  })
})

describe('rankScopes — specificity tie-break (#399)', () => {
  it('between two equal-confidence forward domain matches, the more specific cover wins (not the name)', () => {
    // domain forward-matches BOTH covers; both score WEIGHT_DOMAIN ⟹ equal confidence.
    // The deeper cover (plur.core, depth 2) is the better home than plur (depth 1),
    // even though its scope name sorts LAST alphabetically.
    const broad = { scope: 'group:aaa-broad', covers: ['plur'] }
    const specific = { scope: 'group:zzz-specific', covers: ['plur.core'] }
    const ranked = rankScopes({ statement: 'x', domain: 'plur.core.security' }, [broad, specific])
    expect(ranked[0].confidence).toBe(ranked[1].confidence) // genuinely a tie on confidence
    expect(ranked[0].scope).toBe('group:zzz-specific')      // specificity beats alphabetical
  })
})

describe('isSharedScope — public-prefix boundary (#403)', () => {
  it('classifies the public namespace as shared but NOT string-prefix siblings', () => {
    expect(isSharedScope('public')).toBe(true)
    expect(isSharedScope('public:roadmap')).toBe(true)
    expect(isSharedScope('public/x')).toBe(true)
    // personal scopes that merely start with the letters "public"
    expect(isSharedScope('publicfoobar')).toBe(false)
    expect(isSharedScope('public-roadmap')).toBe(false)
    // sanity: the colon-delimited prefixes and personal scopes are unchanged
    expect(isSharedScope('group:plur/eng')).toBe(true)
    expect(isSharedScope('local')).toBe(false)
    expect(isSharedScope('user:gregor')).toBe(false)
  })
})
