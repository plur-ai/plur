/**
 * ADVERSARIAL ROUTING FUZZER (0.10.0 third / final scope-security audit).
 *
 * Exercises the two routing surfaces that decide where a genuinely-UNSCOPED
 * engram lands, across a large generated corpus of (engram-domain × scope-covers)
 * combinations plus tag-only / keyword-only / readonly variants:
 *
 *   1. rankScopes()           — the pure deterministic ranker (scope-routing.ts).
 *                               Asserts the directionality flags it stamps —
 *                               `coverContainsDomain` (FORWARD only) and
 *                               `domainMatch` (either direction) — are computed
 *                               correctly for every pair. These flags are the
 *                               KEY the write-path bypass relies on (reaudit
 *                               finding 4): a wrong flag is a latent over-route.
 *
 *   2. _resolveUnscopedScope() — the actual write-path decision (index.ts). For
 *                               every corpus case it asserts the resolved scope
 *                               against an INDEPENDENT oracle derived from the
 *                               documented contract, and — adversarially — the
 *                               two security-critical invariants directly:
 *                                 • NO OVER-ROUTE: a reverse-only (domain ⊃ cover,
 *                                   "engram broader than the narrow scope") or a
 *                                   weak (tag-/keyword-only sub-threshold) signal
 *                                   must NOT land in a shared scope — it falls to
 *                                   the unscoped default.
 *                                 • NO UNDER-ROUTE: a clean FORWARD domain match
 *                                   (cover ⊃ domain or cover === domain) to a
 *                                   WRITABLE scope must route there.
 *                                 • Readonly scopes are excluded from auto-route.
 *
 * The oracle is built from the spec text, NOT by calling the production ranker,
 * so a bug in rankScopes that flips a flag is caught by surface (1), and a bug in
 * _resolveUnscopedScope that mis-applies the flags/threshold is caught by the
 * scope mismatch in surface (2). The two cross-check each other.
 *
 * DURABLE — keep this file. A failure here is a real finding.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, rankScopes, SCOPE_MATCH_THRESHOLD } from '../../src/index.js'
import { isSharedScope } from '../../src/scope-util.js'

// ---------------------------------------------------------------------------
// Independent oracle helpers — derived from the SPEC, not the implementation.
// ---------------------------------------------------------------------------

/** Normalize a cover token the way the ranker does: lowercase, strip trailing
 * glob. Re-implemented here so the oracle does not import the private helper. */
function normCover(cover: string): string {
  return cover.toLowerCase().replace(/\.?\*$/, '')
}

/** `value` sits under `prefix` as a dotted namespace (equality counts). */
function isNsPrefix(prefix: string, value: string): boolean {
  if (!prefix) return false
  return value === prefix || value.startsWith(prefix + '.')
}

type DomainDir = 'forward' | 'reverse' | 'none'

/**
 * Independently classify the domain channel for a (domain, covers) pair:
 *   forward — some cover ⊃ domain or cover === domain  (engram belongs in scope)
 *   reverse — domain ⊃ some cover (strictly)           (engram broader than scope)
 *   none    — no namespace relation
 * Forward takes precedence (the ranker breaks on the first forward hit), so if
 * ANY cover is forward we report forward.
 */
function classifyDomain(domain: string | undefined, covers: string[]): DomainDir {
  const d = domain?.toLowerCase().trim()
  if (!d) return 'none'
  const norms = covers.map(normCover).filter(c => c.length > 0)
  if (norms.some(c => isNsPrefix(c, d))) return 'forward'   // cover ⊃ domain
  if (norms.some(c => isNsPrefix(d, c))) return 'reverse'   // domain ⊃ cover
  return 'none'
}

// ---------------------------------------------------------------------------
// Plur construction (mirrors route-unscoped.test.ts makePlur).
// ---------------------------------------------------------------------------
const dirs: string[] = []
function makePlur(config: Record<string, unknown>): Plur {
  const dir = mkdtempSync(join(tmpdir(), 'plur-routing-fuzz-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, ...config }, { noRefs: true }))
  return new Plur({ path: dir })
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

type Resolver = {
  _resolveUnscopedScope: (
    s: string,
    c?: { domain?: string; tags?: string[] },
  ) => { scope: string; routed: { scope: string; confidence: number; reason: string } | null }
}

// ---------------------------------------------------------------------------
// Corpus generation.
// ---------------------------------------------------------------------------

const SHARED_SCOPE = 'group:plur/core' // a SHARED, writable scope
const FALLBACK = 'global'              // schema default unscoped_default

/** Domains spanning broad → specific, plus adversarial near-misses. */
const DOMAINS = [
  'plur',
  'plur.core',
  'plur.core.security',
  'plur.core.security.tokens',
  'plurple',            // segment-boundary near-miss: NOT under 'plur'
  'plur2',              // near-miss
  'other.namespace',    // unrelated
  'PLUR.Core',          // case variation → forward against plur.core
  ' plur.core ',        // whitespace variation
  undefined,            // no domain
] as const

/** Cover sets spanning glob/exact/narrow/broad/empty/unrelated. */
const COVER_SETS: string[][] = [
  ['plur.*'],
  ['plur'],
  ['plur.core'],
  ['plur.core.*'],
  ['plur.core.security'],
  ['plur.core.security.tokens'],
  ['plur.core.security.tokens.deep'], // narrower than every domain → reverse for specific domains
  ['servers'],                         // unrelated to plur domains
  ['plurple'],                         // near-miss token
  [],                                  // no covers → omitted entirely
]

// ---------------------------------------------------------------------------
// SURFACE 1 — pure ranker directionality. Exhaustive over DOMAINS × COVER_SETS.
// ---------------------------------------------------------------------------
describe('routing-fuzz — rankScopes directionality flags (forward/reverse classification)', () => {
  const wrong: string[] = []
  let cases = 0

  it('coverContainsDomain is set IFF the domain match is FORWARD; domainMatch covers either direction', () => {
    for (const domain of DOMAINS) {
      for (const covers of COVER_SETS) {
        cases++
        const ranked = rankScopes(
          { statement: 'xyzzy nonoverlapping unique tokens qwertz', domain, tags: [] },
          [{ scope: SHARED_SCOPE, covers }],
        )
        const cand = ranked.find(c => c.scope === SHARED_SCOPE)
        const dir = classifyDomain(domain, covers)

        if (dir === 'forward') {
          if (!cand) { wrong.push(`FORWARD but no candidate: domain=${String(domain)} covers=${JSON.stringify(covers)}`); continue }
          if (!cand.coverContainsDomain)
            wrong.push(`FORWARD but coverContainsDomain=false: domain=${String(domain)} covers=${JSON.stringify(covers)} reason="${cand.reason}"`)
          if (!cand.domainMatch)
            wrong.push(`FORWARD but domainMatch=false: domain=${String(domain)} covers=${JSON.stringify(covers)}`)
        } else if (dir === 'reverse') {
          if (!cand) { wrong.push(`REVERSE but no candidate: domain=${String(domain)} covers=${JSON.stringify(covers)}`); continue }
          // Reverse: domainMatch true, coverContainsDomain MUST be false (the
          // over-route guard). A true here is a latent over-route bug.
          if (cand.coverContainsDomain)
            wrong.push(`REVERSE but coverContainsDomain=TRUE (over-route risk): domain=${String(domain)} covers=${JSON.stringify(covers)} reason="${cand.reason}"`)
          if (!cand.domainMatch)
            wrong.push(`REVERSE but domainMatch=false: domain=${String(domain)} covers=${JSON.stringify(covers)}`)
          // A lone reverse hit must squash strictly below threshold (down-weighted).
          if (cand.confidence >= SCOPE_MATCH_THRESHOLD)
            wrong.push(`REVERSE lone hit confidence>=threshold (${cand.confidence}): domain=${String(domain)} covers=${JSON.stringify(covers)}`)
        } else {
          // No domain relation: if a candidate exists at all it must NOT claim a
          // domain match in either flag (it could exist via tag/keyword, but here
          // tags=[] and the statement shares no tokens, so usually no candidate).
          if (cand?.coverContainsDomain)
            wrong.push(`NONE but coverContainsDomain=true: domain=${String(domain)} covers=${JSON.stringify(covers)} reason="${cand.reason}"`)
          if (cand?.domainMatch)
            wrong.push(`NONE but domainMatch=true: domain=${String(domain)} covers=${JSON.stringify(covers)} reason="${cand.reason}"`)
        }
      }
    }
    expect(cases).toBeGreaterThan(80)
    expect(wrong, `directionality mismatches:\n${wrong.join('\n')}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// SURFACE 2 — write-path decision via _resolveUnscopedScope.
//
// Oracle decision rule (from index.ts contract):
//   if auto_route_scope === false        → FALLBACK
//   drop readonly scopes from candidates
//   forward domain match (writable)      → that scope          (deterministic bypass)
//   else top.confidence >= threshold     → that scope          (>= gate)
//   else                                 → FALLBACK
//
// We test single-scope configs so "top" is unambiguous, and assert the resolved
// scope against the oracle PLUS the two adversarial security invariants.
// ---------------------------------------------------------------------------
describe('routing-fuzz — _resolveUnscopedScope no-over-route / no-under-route', () => {
  // Each scenario fixes a scope (writable or readonly) and varies the engram
  // signals. The statement is token-disjoint from covers so the ONLY signals are
  // the domain channel and explicit tags — keeping the oracle tractable.
  const STMT = 'xyzzy nonoverlapping unique tokens qwertz' // shares no cover tokens

  type Case = {
    label: string
    covers: string[]
    readonly: boolean
    domain?: string
    tags?: string[]
    /** Expected resolved scope per the independent oracle. */
    expect: string
  }

  const SCOPE = SHARED_SCOPE
  const cases: Case[] = []

  // (a) Domain × cover matrix on a WRITABLE shared scope, no tags.
  for (const domain of DOMAINS) {
    for (const covers of COVER_SETS) {
      const dir = classifyDomain(domain, covers)
      // Oracle: forward → route to scope; reverse/none with a lone signal → fallback
      // (reverse squashes to 0.25 < 0.5; none has no candidate). Empty covers →
      // scope omitted entirely → fallback.
      const exp = dir === 'forward' && covers.length > 0 ? SCOPE : FALLBACK
      cases.push({
        label: `writable domain=${String(domain)} covers=${JSON.stringify(covers)} (${dir})`,
        covers,
        readonly: false,
        domain,
        expect: exp,
      })
    }
  }

  // (b) Readonly scope: a FORWARD domain match must STILL fall to fallback
  // (readonly excluded from auto-route candidates).
  for (const covers of [['plur.*'], ['plur.core'], ['plur']]) {
    cases.push({
      label: `readonly forward covers=${JSON.stringify(covers)}`,
      covers,
      readonly: true,
      domain: 'plur.core.security',
      expect: FALLBACK,
    })
  }

  // (c) Tag-only matches: 1 tag (0.25), 2 tags (0.40) → fallback; 3 tags (0.50) → route.
  cases.push({ label: 'tag-only x1 (0.25 < thr)', covers: ['a'], readonly: false, tags: ['a'], expect: FALLBACK })
  cases.push({ label: 'tag-only x2 (0.40 < thr)', covers: ['a', 'b'], readonly: false, tags: ['a', 'b'], expect: FALLBACK })
  cases.push({ label: 'tag-only x3 (0.50 >= thr)', covers: ['a', 'b', 'c'], readonly: false, tags: ['a', 'b', 'c'], expect: SCOPE })

  // (d) Reverse domain + tags: reverse(0.5)+3 tags(1.5)=2.0 → squash 0.571 → routes
  // via the >= gate (reverse contributes, is not discarded).
  cases.push({
    label: 'reverse domain + 3 tags clears threshold',
    covers: ['plur.core', 'alpha', 'beta', 'gamma'],
    readonly: false,
    domain: 'plur',
    tags: ['alpha', 'beta', 'gamma'],
    expect: SCOPE,
  })

  // (e) Reverse domain alone (the canonical over-route scenario) → fallback.
  cases.push({
    label: 'reverse domain alone (over-route scenario) → fallback',
    covers: ['plur.core'],
    readonly: false,
    domain: 'plur',
    expect: FALLBACK,
  })

  const failures: string[] = []
  const overRoutes: string[] = []
  const underRoutes: string[] = []

  it('resolves every case per the independent oracle, with no over-route into the shared scope and no under-route of a forward match', () => {
    for (const c of cases) {
      const store: Record<string, unknown> = c.readonly
        ? { url: 'https://ro.example.com', token: 't', readonly: true, scope: SCOPE, description: 'S', covers: c.covers }
        : { path: '/tmp/fuzz.yaml', scope: SCOPE, description: 'S', covers: c.covers }
      const plur = makePlur({ stores: [store] }) as unknown as Resolver
      const res = plur._resolveUnscopedScope(c.domain ? STMT : STMT, { domain: c.domain, tags: c.tags })

      if (res.scope !== c.expect)
        failures.push(`${c.label}: oracle=${c.expect} got=${res.scope} routed=${JSON.stringify(res.routed)}`)

      // SECURITY INVARIANT 1 — NO OVER-ROUTE. The shared scope is reached only
      // when the oracle says so. Any reverse-only or sub-threshold signal landing
      // in the shared scope is an over-route leak.
      if (res.scope === SCOPE && c.expect !== SCOPE)
        overRoutes.push(`${c.label}: landed in SHARED ${SCOPE} (oracle=${c.expect})`)

      // SECURITY INVARIANT 2 — NO UNDER-ROUTE of a clean forward match to a
      // writable scope (a forward case that fell to fallback).
      if (c.expect === SCOPE && res.scope !== SCOPE)
        underRoutes.push(`${c.label}: forward/threshold match did NOT route (got ${res.scope})`)

      // The shared scope is in fact shared (sanity on the predicate the guard uses).
      expect(isSharedScope(SCOPE)).toBe(true)
    }

    expect(overRoutes, `OVER-ROUTE (leak) cases:\n${overRoutes.join('\n')}`).toEqual([])
    expect(underRoutes, `UNDER-ROUTE cases:\n${underRoutes.join('\n')}`).toEqual([])
    expect(failures, `oracle mismatches:\n${failures.join('\n')}`).toEqual([])
  })

  it('auto_route_scope:false never routes regardless of a perfect forward domain match', () => {
    const bad: string[] = []
    for (const covers of [['plur.*'], ['plur'], ['plur.core']]) {
      const plur = makePlur({
        auto_route_scope: false,
        stores: [{ path: '/tmp/fuzz.yaml', scope: SCOPE, description: 'S', covers }],
      }) as unknown as Resolver
      const res = plur._resolveUnscopedScope(STMT, { domain: 'plur.core.security' })
      if (res.scope !== FALLBACK || res.routed !== null)
        bad.push(`covers=${JSON.stringify(covers)} → scope=${res.scope} routed=${JSON.stringify(res.routed)}`)
    }
    expect(bad, `auto_route_scope:false leaked a route:\n${bad.join('\n')}`).toEqual([])
  })

  it('multi-candidate forward ties resolve deterministically and stay within a forward scope', () => {
    // Two shared scopes that both forward-match the domain. Winner must be one of
    // them (never fallback — that would be an under-route) and deterministic.
    const plur = makePlur({
      stores: [
        { path: '/tmp/b.yaml', scope: 'group:plur/b', description: 'B', covers: ['plur.*'] },
        { path: '/tmp/a.yaml', scope: 'group:plur/a', description: 'A', covers: ['plur.core.*'] },
      ],
    }) as unknown as Resolver
    const r1 = plur._resolveUnscopedScope(STMT, { domain: 'plur.core.security' })
    const r2 = plur._resolveUnscopedScope(STMT, { domain: 'plur.core.security' })
    expect(r1.scope).toBe(r2.scope)                  // deterministic
    expect(['group:plur/a', 'group:plur/b']).toContain(r1.scope) // forward, not fallback
  })
})
