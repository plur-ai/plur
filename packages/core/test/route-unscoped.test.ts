/**
 * Stage 3b (#351): auto-route genuinely-unscoped writes via suggestScope, else
 * fall to `unscoped_default`. This is the BEHAVIOR FLIP that Stage 3a
 * (scope-routing.ts / suggestScope) deliberately left inert.
 *
 * The write path only auto-routes when the caller is TRULY unscoped — no
 * explicit `scope` AND no session/`.plur.yaml` default (both land in the
 * session scope). An explicit scope or a session default is honored UNCHANGED.
 * The sensitivity guard still runs AFTER scope selection, so an auto-routed
 * SHARED scope carrying sensitive content is still demoted to local.
 *
 * Confidence note: SCOPE_MATCH_THRESHOLD is 0.5, and squash(raw)=raw/(raw+1.5),
 * so a confident auto-route needs raw weight >= 1.5. As of 0.10.0 (#353,
 * finding-11) WEIGHT_DOMAIN is 1.5, so a LONE domain-prefix hit clears it on its
 * own: squash(1.5)=1.5/3.0=0.5, which the `>=` gate accepts. The lone-domain
 * boundary is pinned in scope-routing.test.ts (THRESHOLD_SINGLE_DOMAIN) and in
 * the "lone domain-prefix match auto-routes" case below; the stores here stack
 * domain + tag (+ keyword) so they sit comfortably above the boundary.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'

// PR-6: wrap rankScopes so individual tests can inject a hand-built ranked list
// (e.g. a sub-threshold domain candidate) to prove the deterministic bypass is
// decoupled from SCOPE_MATCH_THRESHOLD. By DEFAULT it delegates to the real
// implementation, so every other test in this file uses genuine ranking.
const { rankScopes: realRankScopes } =
  await vi.importActual<typeof import('../src/scope-routing.js')>('../src/scope-routing.js')
const routeMock = vi.fn(realRankScopes)
vi.mock('../src/scope-routing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scope-routing.js')>()
  return { ...actual, rankScopes: (...args: Parameters<typeof actual.rankScopes>) => routeMock(...args) }
})

const { Plur, SCOPE_MATCH_THRESHOLD } = await import('../src/index.js')

const dirs: string[] = []

/** Build a Plur whose config carries the given stores + any extra config keys. */
function makePlur(config: Record<string, unknown>): Plur {
  const dir = mkdtempSync(join(tmpdir(), 'plur-route-unscoped-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, ...config }, { noRefs: true }))
  return new Plur({ path: dir })
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  routeMock.mockReset()
  routeMock.mockImplementation(realRankScopes) // restore real ranking after any mockReturnValueOnce
})

describe('Stage 3b — auto-route un-scoped writes (#351)', () => {
  it('routes an un-scoped write to a covers-matched scope (confident), stamps _routed', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*', 'embeddings', 'core'] },
      ],
    })
    // Domain-prefix hit (plur.core.embeddings ⊂ plur.*) + tag hit (embeddings) +
    // keyword hits push raw well above 1.5 → confidence >= threshold.
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
    }) as { scope: string; structured_data?: { _routed?: { scope: string; confidence: number; reason: string } } }

    expect(e.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed).toBeDefined()
    expect(e.structured_data?._routed?.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed?.confidence).toBeGreaterThanOrEqual(SCOPE_MATCH_THRESHOLD)
    expect(e.structured_data?._routed?.reason).toBeTruthy()
  })

  it('falls to global (the default, reverted in 0.10.0 #353) when no covers match', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*', 'embeddings'] },
      ],
    })
    const e = plur.learn('completely unrelated note about lunch preferences') as {
      scope: string; structured_data?: { _routed?: unknown }
    }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('unscoped_default: "global" sends an unmatched write to global (explicit; also the default)', () => {
    const plur = makePlur({
      unscoped_default: 'global',
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*'] },
      ],
    })
    const e = plur.learn('unrelated note that matches no covers') as {
      scope: string; structured_data?: { _routed?: unknown }
    }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('unscoped_default: "local" sends an unmatched write to local (opt-out of global)', () => {
    const plur = makePlur({
      unscoped_default: 'local',
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*'] },
      ],
    })
    const e = plur.learn('unrelated note that matches no covers') as {
      scope: string; structured_data?: { _routed?: unknown }
    }
    expect(e.scope).toBe('local')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('honors an explicit scope — NO auto-route, no _routed marker', () => {
    const plur = makePlur({
      stores: [
        // covers would confidently match, but the caller chose a scope explicitly.
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*', 'embeddings'] },
      ],
    })
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
      scope: 'local',
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('local')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('honors a session default_scope — NO auto-route, no _routed marker', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*', 'embeddings'] },
      ],
    })
    plur.setSessionScope('project:my-app')
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('project:my-app')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('auto_route_scope:false disables routing — unscoped falls straight to default (global)', () => {
    const plur = makePlur({
      auto_route_scope: false,
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*', 'embeddings'] },
      ],
    })
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('a LONE domain-prefix match auto-routes (confidence 0.50), stamps _routed (finding-11)', () => {
    const plur = makePlur({
      stores: [
        // covers is a single namespace glob; the statement shares NO tokens with
        // it, so the ONLY signal is the domain-prefix hit (plur.core.security ⊂
        // plur.*) → raw = WEIGHT_DOMAIN = 1.5 → squash(1.5) = 0.50, which the `>=`
        // gate accepts. Pre-0.10.0 (WEIGHT_DOMAIN=1.0) this squashed to 0.40 and
        // the strongest, most deliberate signal never auto-routed — the bug.
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*'] },
      ],
    })
    const e = plur.learn('xyzzy nonoverlapping content tokens', {
      domain: 'plur.core.security',
    }) as { scope: string; structured_data?: { _routed?: { scope: string; confidence: number; reason: string } } }
    expect(e.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed).toBeDefined()
    expect(e.structured_data?._routed?.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed?.confidence).toBe(0.5)
    expect(e.structured_data?._routed?.confidence).toBeGreaterThanOrEqual(SCOPE_MATCH_THRESHOLD)
  })

  it('a LONE tag-only match does NOT auto-route (0.25 < 0.5) — falls to default', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-infra.yaml', scope: 'group:plur/infra', description: 'Infra', covers: ['servers'] },
      ],
    })
    // Single tag hit → raw = WEIGHT_TAG = 0.5 → squash(0.5) = 0.25 < threshold.
    const e = plur.learn('no overlap words zzz', {
      tags: ['servers'],
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('a LONE single-keyword match does NOT auto-route (0.118 < 0.5) — falls to default', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-infra.yaml', scope: 'group:plur/infra', description: 'Infra', covers: ['servers'] },
      ],
    })
    // One statement keyword overlaps a cover token → raw = WEIGHT_KEYWORD = 0.2.
    const e = plur.learn('restart the servers now') as {
      scope: string; structured_data?: { _routed?: unknown }
    }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('excludes a readonly URL-based store from auto-route targets (MED-12 — not labeled routed-to-readonly)', () => {
    const plur = makePlur({
      stores: [
        // A readonly REMOTE store whose covers would confidently match. Because a
        // write can never land here (_resolveRemoteStoreForScope continues on
        // readonly), the ranker must not LABEL it as the auto-route target.
        { url: 'https://ro.example.com', token: 't', readonly: true, scope: 'group:plur/core', description: 'Core (RO)', covers: ['plur.*', 'embeddings'] },
      ],
    })
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    // Falls to the unscoped default (global), NOT routed to the readonly scope.
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('excludes a readonly PATH-based store from auto-route targets (MED-12)', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core-ro.yaml', readonly: true, scope: 'group:plur/core', description: 'Core (RO)', covers: ['plur.*', 'embeddings'] },
      ],
    })
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('a WRITABLE store with the same covers still auto-routes (proves the filter is readonly-specific)', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core-rw.yaml', readonly: false, scope: 'group:plur/core', description: 'Core (RW)', covers: ['plur.*', 'embeddings'] },
      ],
    })
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
    }) as { scope: string; structured_data?: { _routed?: { scope: string } } }
    expect(e.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed?.scope).toBe('group:plur/core')
  })

  it('suggestScope (advisory) STILL surfaces a readonly scope as a candidate (discovery unchanged)', () => {
    const plur = makePlur({
      stores: [
        { url: 'https://ro.example.com', token: 't', readonly: true, scope: 'group:plur/core', description: 'Core (RO)', covers: ['plur.*', 'embeddings'] },
      ],
    })
    // The readonly filter applies ONLY to the auto-route candidate set inside
    // _resolveUnscopedScope. Advisory discovery (suggestScope/listScopeMetadata)
    // must still show readonly scopes so a human can find them.
    const ranked = plur.suggestScope({ statement: 'embeddings core', domain: 'plur.core.embeddings', tags: ['embeddings'] })
    expect(ranked.map(c => c.scope)).toContain('group:plur/core')
  })

  // --- PR-6 (#353): a FULL domain-prefix match routes DETERMINISTICALLY,
  // bypassing the squash/threshold edge. Weak signals (tag-only / keyword-only)
  // stay gated by the threshold; readonly scopes stay excluded; weights/threshold
  // are unchanged. ---

  it('PR-6: a full domain-prefix match routes deterministically (via the bypass, not the >= edge)', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*'] },
      ],
    })
    // Domain-only hit, zero token overlap. Under the weight curve this squashes
    // to EXACTLY 0.50 = SCOPE_MATCH_THRESHOLD — pre-PR-6 it routed only by landing
    // on the `>=` edge. PR-6 routes it via the deterministic domainMatch bypass
    // instead (taken BEFORE the threshold check), so the route no longer depends
    // on the confidence sitting precisely on the threshold.
    const e = plur.learn('xyzzy nonoverlapping content tokens', {
      domain: 'plur.core.security',
    }) as { scope: string; structured_data?: { _routed?: { scope: string; confidence: number; reason: string } } }
    expect(e.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed?.scope).toBe('group:plur/core')
    // The route is for a domain reason (proves it came through the domain channel,
    // i.e. the deterministic branch, not a coincidental tag/keyword pile-up).
    expect(e.structured_data?._routed?.reason).toContain('domain plur.core.security')
  })

  it('R2-C: the bypass is taken BEFORE the threshold gate — a sub-threshold FORWARD (coverContainsDomain) candidate STILL routes', () => {
    // Rigorously decouples the bypass from SCOPE_MATCH_THRESHOLD. We feed the
    // private resolver a hand-built ranked list (via a mocked rankScopes) whose
    // top candidate has `coverContainsDomain:true` (FORWARD: cover ⊃ domain) but a
    // confidence WELL BELOW threshold (0.2). Threshold-only logic would refuse to
    // route it; the deterministic forward-domain branch is taken first so it
    // routes. Subsequent lists prove the bypass is gated on `coverContainsDomain`
    // — NOT on `domainMatch` (which is also true for the reverse direction) and
    // NOT just on having a candidate (reaudit finding 4, R2-C).
    const plur = makePlur({
      stores: [{ path: '/tmp/r.yaml', scope: 'group:plur/core', covers: ['plur.*'], description: 'Core' }],
    }) as unknown as {
      _resolveUnscopedScope: (s: string, c?: { domain?: string }) => { scope: string; routed: { scope: string } | null }
    }

    // FORWARD: coverContainsDomain:true, confidence 0.2 (< 0.5) → routes via bypass.
    routeMock.mockReturnValueOnce([
      { scope: 'group:plur/core', confidence: 0.2, reason: 'domain x ⊂ covers plur.*', domainMatch: true, coverContainsDomain: true },
    ])
    const routedLow = plur._resolveUnscopedScope('anything', { domain: 'plur.core.x' })
    expect(routedLow.scope).toBe('group:plur/core')
    expect(routedLow.routed?.scope).toBe('group:plur/core')

    // REVERSE: domainMatch:true BUT coverContainsDomain:false, confidence 0.2
    // (< 0.5) → must NOT route (the over-route case: broad engram, narrow scope).
    // Keying on domainMatch (the old bug) would have routed this; keying on
    // coverContainsDomain correctly gates it.
    routeMock.mockReturnValueOnce([
      { scope: 'group:plur/core', confidence: 0.2, reason: 'domain plur ⊃ covers plur.core', domainMatch: true, coverContainsDomain: false },
    ])
    const reverseLow = plur._resolveUnscopedScope('anything', { domain: 'plur' })
    expect(reverseLow.scope).toBe('global')
    expect(reverseLow.routed).toBeNull()

    // WEAK: neither flag set, same low confidence 0.2 (< 0.5) → must NOT route.
    routeMock.mockReturnValueOnce([
      { scope: 'group:plur/core', confidence: 0.2, reason: 'keywords [...]', domainMatch: false, coverContainsDomain: false },
    ])
    const gatedLow = plur._resolveUnscopedScope('anything')
    expect(gatedLow.scope).toBe('global')
    expect(gatedLow.routed).toBeNull()
  })

  it('PR-6: a tag-only match (no domain) is STILL gated by threshold — two tags fall to default', () => {
    const plur = makePlur({
      stores: [
        // Two cover tokens, hit by two tags → raw 1.0 → squash 0.40 < 0.5, and
        // NO domain match. The bypass must not fire; the write stays gated.
        { path: '/tmp/r-infra.yaml', scope: 'group:plur/infra', description: 'Infra', covers: ['servers', 'deploy'] },
      ],
    })
    const e = plur.learn('no overlap words zzz', {
      tags: ['servers', 'deploy'],
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('PR-6: a tag-only match that DOES clear threshold (three tags) still routes (threshold path intact)', () => {
    const plur = makePlur({
      stores: [
        // Three tags → raw 1.5 → squash 0.50, NO domain. The threshold path (not
        // the bypass) routes it — proves PR-6 left the weak-signal gate working.
        { path: '/tmp/r-infra.yaml', scope: 'group:plur/infra', description: 'Infra', covers: ['servers', 'deploy', 'infra'] },
      ],
    })
    const e = plur.learn('no overlap words zzz', {
      tags: ['servers', 'deploy', 'infra'],
    }) as { scope: string; structured_data?: { _routed?: { scope: string } } }
    expect(e.scope).toBe('group:plur/infra')
    expect(e.structured_data?._routed?.scope).toBe('group:plur/infra')
  })

  it('PR-6: a keyword-only match (no domain) is STILL gated by threshold — falls to default', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-infra.yaml', scope: 'group:plur/infra', description: 'Infra', covers: ['servers'] },
      ],
    })
    const e = plur.learn('restart the servers now') as {
      scope: string; structured_data?: { _routed?: unknown }
    }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('PR-6: a readonly scope with a domain match is STILL excluded (not chosen, falls to default)', () => {
    const plur = makePlur({
      stores: [
        // Readonly store whose covers domain-match. PR-4's readonly exclusion runs
        // BEFORE ranking, so the domain candidate never enters the set — the
        // deterministic bypass has nothing to route to.
        { url: 'https://ro.example.com', token: 't', readonly: true, scope: 'group:plur/core', description: 'Core (RO)', covers: ['plur.*'] },
      ],
    })
    const e = plur.learn('zzz no overlap', {
      domain: 'plur.core.security',
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('PR-6: multiple domain-match candidates → deterministic winner (domain-preferring, then scope-name)', () => {
    const plur = makePlur({
      stores: [
        // Both scopes domain-match `plur.core.security` (plur.* and plur.core.*),
        // both score 0.5. Tie-break is deterministic: both are domain matches, so
        // it falls to scope name ascending → group:plur/a wins, every run.
        { path: '/tmp/r-b.yaml', scope: 'group:plur/b', description: 'B', covers: ['plur.*'] },
        { path: '/tmp/r-a.yaml', scope: 'group:plur/a', description: 'A', covers: ['plur.core.*'] },
      ],
    })
    const e = plur.learn('zzz no overlap', {
      domain: 'plur.core.security',
    }) as { scope: string; structured_data?: { _routed?: { scope: string } } }
    expect(e.scope).toBe('group:plur/a')
    expect(e.structured_data?._routed?.scope).toBe('group:plur/a')
  })

  it('R2-C: a FORWARD domain match (cover ⊃ domain) STILL routes deterministically (unchanged)', () => {
    // The intended case, end-to-end via REAL ranking: a specific engram (domain
    // `plur.core.security`) into a broad cover (`plur` / `plur.*`). Cover contains
    // the engram's topic → coverContainsDomain → deterministic bypass routes it.
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur'] },
      ],
    })
    const e = plur.learn('zzz no overlap tokens', {
      domain: 'plur.core.security',
    }) as { scope: string; structured_data?: { _routed?: { scope: string; reason: string } } }
    expect(e.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed?.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed?.reason).toContain('domain plur.core.security ⊂ covers plur')
  })

  it('R2-C: an EXACT domain==cover match STILL routes deterministically', () => {
    // Equality is the forward direction at the boundary (cover === domain) →
    // coverContainsDomain → deterministic bypass.
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.core'] },
      ],
    })
    const e = plur.learn('zzz no overlap tokens', {
      domain: 'plur.core',
    }) as { scope: string; structured_data?: { _routed?: { scope: string } } }
    expect(e.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed?.scope).toBe('group:plur/core')
  })

  it('R2-C OVER-ROUTE REGRESSION: a BROAD engram (domain ⊃ cover) does NOT deterministically route into a narrow shared scope', () => {
    // The exact over-route scenario from reaudit finding 4: a genuinely-unscoped
    // write whose context.domain is a generic top-level namespace (`plur`) against
    // a NARROW shared sub-scope (cover `plur.core`). This is the REVERSE direction
    // — the engram is BROADER than the scope, so it does NOT belong in the narrow
    // scope. Under the old bug (bypass keyed on domainMatch, reverse at full
    // WEIGHT_DOMAIN → conf 0.5) it deterministically landed in group:plur/core.
    // Now: reverse is down-weighted (WEIGHT_DOMAIN_REVERSE → squash(0.5)=0.25 < 0.5)
    // and never sets coverContainsDomain, so it falls to unscoped_default (global).
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.core'] },
      ],
    })
    const e = plur.learn('a broad personal preference about plur in general zzz', {
      domain: 'plur',
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    // Falls to the default — NOT into the narrow shared scope.
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
    // Sanity: the advisory ranker still SURFACES the scope (reverse hit scores > 0)
    // — only the deterministic auto-route is withheld. Confidence stays below
    // threshold so even the `>=` path doesn't fire on the lone reverse match.
    const ranked = plur.suggestScope({ statement: 'zzz', domain: 'plur' })
    const core = ranked.find(c => c.scope === 'group:plur/core')!
    expect(core).toBeDefined()
    expect(core.domainMatch).toBe(true)            // it IS a domain-channel hit…
    expect(core.coverContainsDomain).toBe(false)   // …but the REVERSE direction…
    expect(core.confidence).toBeLessThan(SCOPE_MATCH_THRESHOLD) // …and sub-threshold.
  })

  it('R2-C: a reverse match that DOES clear threshold (reverse + tags) still routes via the >= path', () => {
    // The reverse direction still CONTRIBUTES to the score: a broad-domain engram
    // that ALSO carries enough tag evidence clears the threshold and routes via the
    // normal `>=` gate (not the deterministic bypass). Proves the reverse signal is
    // down-weighted, not discarded. reverse(0.5) + 3 tags(1.5) = raw 2.0 →
    // squash(2.0)=0.5714 >= 0.5.
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.core', 'alpha', 'beta', 'gamma'] },
      ],
    })
    const e = plur.learn('zzz no overlap', {
      domain: 'plur',
      tags: ['alpha', 'beta', 'gamma'],
    }) as { scope: string; structured_data?: { _routed?: { scope: string } } }
    expect(e.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed?.scope).toBe('group:plur/core')
  })

  it('PR-6: explicit scope still bypasses auto-route entirely (domain match ignored)', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*'] },
      ],
    })
    const e = plur.learn('zzz no overlap', {
      domain: 'plur.core.security',
      scope: 'local',
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('local')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('PR-6: a session default still bypasses auto-route entirely (domain match ignored)', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*'] },
      ],
    })
    plur.setSessionScope('project:my-app')
    const e = plur.learn('zzz no overlap', {
      domain: 'plur.core.security',
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('project:my-app')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('auto-routed SHARED scope with sensitive content is still DEMOTED to local (3b + guard)', () => {
    const plur = makePlur({
      stores: [
        // A SHARED group scope (isSharedScope) whose covers confidently match infra content.
        { path: '/tmp/r-infra.yaml', scope: 'group:plur/infra', description: 'Infra', covers: ['plur.*', 'infra', 'deploy'] },
      ],
    })
    // Confident match (domain-prefix + tag) → would route to group:plur/infra,
    // but the statement carries a public IP, so the guard demotes to local/private.
    const e = plur.learn('deploy target for infra is 139.59.155.82', {
      domain: 'plur.infra.deploy',
      tags: ['infra'],
    }) as {
      scope: string; visibility: string
      structured_data?: {
        _routed?: { scope: string; confidence: number }
        _demoted?: { from: string; to: string; patterns: string }
      }
    }
    // Demoted, not routed-as-shared.
    expect(e.scope).toBe('local')
    expect(e.visibility).toBe('private')
    expect(e.structured_data?._demoted?.from).toBe('group:plur/infra')
    expect(e.structured_data?._demoted?.to).toBe('local')
    expect(e.structured_data?._demoted?.patterns).toMatch(/public_ipv4/)
    // The routing decision is preserved alongside the demotion — both facts are true.
    expect(e.structured_data?._routed?.scope).toBe('group:plur/infra')
  })
})
