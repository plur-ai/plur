/**
 * Injection-side behaviour of the pinned two-tier model.
 *
 * The tiers live INSIDE main's pinned budget: origin stays the outer sort
 * key, the hard tier is a sub-cap of the pinned share, the soft tier gets what
 * the hard tier leaves, and anything dropped is reported in `omitted_pinned`.
 * The invariant that matters most: a store that never sets a tier sees exactly
 * the selection it saw before the tiers existed.
 */
import { describe, it, expect } from 'vitest'
import {
  fillTokenBudget, selectAndSpread, estimateTokens, pinnedOriginRank, pinnedHardCap, pinnedShareRatio,
  type OmittedPinned,
} from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

type Scored = ReturnType<typeof mk>

function mk(id: string, opts: {
  statement?: string; score?: number; origin?: 'primary' | 'store' | 'pack'
  tier?: 'hard' | 'soft'; priority?: number; pinned?: boolean; statementDont?: boolean
} = {}) {
  const base = EngramSchema.parse({
    id, statement: opts.statement ?? `Keep rule ${id} in mind when deploying`,
    type: 'behavioral', scope: 'global', status: 'active',
  })
  return {
    ...base,
    ...(opts.pinned === false ? {} : { pinned: true }),
    ...(opts.tier ? { pinned_tier: opts.tier } : {}),
    ...(opts.priority !== undefined ? { pinned_priority: opts.priority } : {}),
    ...(opts.origin === 'store' ? { _storeScope: 'group:org/team' } : {}),
    ...(opts.origin === 'pack' ? { _pack: 'p' } : {}),
    keyword_match: 1, raw_score: 1, score: opts.score ?? 1,
  }
}

/**
 * main's pinned selection before the tiers, verbatim in behaviour — the
 * reference the invariant is checked against.
 */
function mainReference(scored: Scored[], maxTokens: number, base: number, ledger: { spent: number }) {
  const selected: string[] = []
  const omitted: OmittedPinned[] = []
  let used = 0
  const pinned = scored.filter(e => e.pinned === true).sort((a, b) =>
    pinnedOriginRank(a as never) - pinnedOriginRank(b as never) || b.score - a.score)
  const pinnedBudget = Math.floor(base * 0.5)
  let skippedRank: number | null = null
  for (const e of pinned) {
    const rank = pinnedOriginRank(e as never)
    const cost = estimateTokens(e as never)
    if (skippedRank !== null && rank > skippedRank) { omitted.push({ id: e.id, cost, reason: 'pinned-sub-budget' }); continue }
    if (used + cost > maxTokens) { omitted.push({ id: e.id, cost, reason: 'total-budget' }); skippedRank = skippedRank === null ? rank : Math.min(skippedRank, rank); continue }
    if (ledger.spent + cost > pinnedBudget) { omitted.push({ id: e.id, cost, reason: 'pinned-sub-budget' }); skippedRank = skippedRank === null ? rank : Math.min(skippedRank, rank); continue }
    selected.push(e.id); used += cost; ledger.spent += cost
  }
  return { selected, omitted, used }
}

describe('invariant: no tiers set → exactly the pre-tier selection', () => {
  it('matches the reference over randomised stores, budgets and shared-ledger passes', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    const origins = ['primary', 'store', 'pack'] as const
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rnd() * 25)
      const all = Array.from({ length: n }, (_, i) => mk(`ENG-2026-09-28-${String(i).padStart(3, '0')}`, {
        statement: 'w'.repeat(20 + Math.floor(rnd() * 600)),
        score: Math.round(rnd() * 100) / 100,
        origin: origins[Math.floor(rnd() * 3)],
        pinned: rnd() < 0.8,
      }))
      const maxTokens = 50 + Math.floor(rnd() * 3000)
      // Two passes sharing one ledger, as selectAndSpread runs them.
      const split = Math.floor(rnd() * n)
      const passes = [all.slice(0, split), all.slice(split)]
      const refLedger = { spent: 0 }
      const newLedger = { spent: 0 }
      for (const pass of passes) {
        const budget = Math.floor(maxTokens * (0.3 + rnd() * 0.7))
        const ref = mainReference(pass, budget, maxTokens, refLedger)
        const got = fillTokenBudget(pass as never, budget, maxTokens, newLedger)
        expect(got.selected.filter(e => (e as { pinned?: boolean }).pinned === true).map(e => e.id)).toEqual(ref.selected)
        expect(got.omitted_pinned).toEqual(ref.omitted)
        expect(newLedger.spent).toBe(refLedger.spent)
      }
    }
  })
})

describe('ordering within the pinned budget', () => {
  it('hard before soft within an origin', () => {
    const soft = mk('ENG-SOFT', { score: 0.9 })
    const hard = mk('ENG-HARD', { tier: 'hard', score: 0.1 })
    const out = fillTokenBudget([soft, hard] as never, 8000)
    expect(out.selected.map(e => e.id)).toEqual(['ENG-HARD', 'ENG-SOFT'])
  })

  it('origin stays the outer key: a primary soft pin beats a remote hard pin', () => {
    const remoteHard = mk('ENG-REMOTE-HARD', { tier: 'hard', origin: 'store' })
    const primarySoft = mk('ENG-PRIMARY-SOFT')
    const out = fillTokenBudget([remoteHard, primarySoft] as never, 8000)
    expect(out.selected.map(e => e.id)).toEqual(['ENG-PRIMARY-SOFT', 'ENG-REMOTE-HARD'])
  })

  it('soft pins order by priority, then score (not by age)', () => {
    const low = mk('ENG-LOW', { priority: 10, score: 0.9 })
    const high = mk('ENG-HIGH', { priority: 90, score: 0.1 })
    const tieA = mk('ENG-TIE-A', { priority: 50, score: 0.2 })
    const tieB = mk('ENG-TIE-B', { priority: 50, score: 0.8 })
    const out = fillTokenBudget([low, tieA, high, tieB] as never, 8000)
    expect(out.selected.map(e => e.id)).toEqual(['ENG-HIGH', 'ENG-TIE-B', 'ENG-TIE-A', 'ENG-LOW'])
  })

  it('an out-of-range stored priority is clamped, not trusted', () => {
    const forged = mk('ENG-FORGED', { priority: 9999, score: 0.1 })
    const top = mk('ENG-TOP', { priority: 100, score: 0.9 })
    const out = fillTokenBudget([forged, top] as never, 8000)
    expect(out.selected.map(e => e.id)).toEqual(['ENG-TOP', 'ENG-FORGED'])
  })
})

describe('budgets and reporting', () => {
  it('the hard tier is capped at its share of the pinned budget and the overflow is reported', () => {
    const maxTokens = 2000 // pinned share 1000, hard cap 500
    const hard = Array.from({ length: 10 }, (_, i) => mk(`ENG-H-${i}`, { tier: 'hard', statement: 'h'.repeat(400) }))
    const out = fillTokenBudget(hard as never, maxTokens)
    const used = out.selected.reduce((n, e) => n + estimateTokens(e), 0)
    expect(used).toBeLessThanOrEqual(pinnedHardCap(maxTokens))
    expect(out.selected.length).toBeGreaterThan(0)
    const reasons = new Set(out.omitted_pinned.map(o => o.reason))
    expect(reasons).toEqual(new Set(['hard-tier-cap']))
    expect(out.omitted_pinned.length + out.selected.length).toBe(10)
  })

  it('hard-tier overflow reaches the injection result instead of vanishing', () => {
    const hard = Array.from({ length: 10 }, (_, i) => mk(`ENG-H-${i}`, { tier: 'hard', statement: `deploy rule ${i} ${'h'.repeat(400)}` }))
    const res = selectAndSpread({ prompt: 'deploy', maxTokens: 2000 }, hard as never, [])
    expect(res.omitted_pinned.some(o => o.reason === 'hard-tier-cap')).toBe(true)
  })

  it('the soft tier gets what the hard tier leaves; explicit soft overflow says soft-tier-budget', () => {
    const maxTokens = 2000
    const hard = mk('ENG-H', { tier: 'hard', statement: 'h'.repeat(1600) }) // ~420 of the 500 hard cap
    const soft = Array.from({ length: 6 }, (_, i) => mk(`ENG-S-${i}`, { tier: 'soft', statement: 's'.repeat(400) }))
    const out = fillTokenBudget([hard, ...soft] as never, maxTokens)
    const hardCost = estimateTokens(hard as never)
    const softUsed = out.selected.filter(e => e.id !== 'ENG-H').reduce((n, e) => n + estimateTokens(e), 0)
    expect(out.selected.map(e => e.id)).toContain('ENG-H')
    expect(softUsed).toBeLessThanOrEqual(1000 - hardCost)
    expect(out.omitted_pinned.every(o => o.reason === 'soft-tier-budget')).toBe(true)
    expect(out.omitted_pinned.length).toBeGreaterThan(0)
  })

  it('a soft pin in an earlier pass cannot spend the hard tier\'s reservation', () => {
    // Constraints are filled first. Without a reservation computed over ALL
    // candidates, soft constraint pins would exhaust the pinned share before
    // the hard directive pin is looked at — inverting the tiers.
    // maxTokens 2000: pinned share 1000, hard cap 500, constraints floor 800.
    // The soft constraints alone would fill the 800 floor; the ~300-token hard
    // pin then only fits if 300 of the share was held back for it.
    const softConstraints = Array.from({ length: 10 }, (_, i) =>
      mk(`ENG-C-${i}`, { statement: `Never deploy on a Friday, variant ${i} ${'c'.repeat(330)}` }))
    const hardDirective = mk('ENG-HARD-DIR', { tier: 'hard', statement: `Always tag the release before deploy ${'d'.repeat(1100)}` })
    expect(estimateTokens(hardDirective as never)).toBeGreaterThan(200)
    expect(estimateTokens(hardDirective as never)).toBeLessThan(500)
    const res = selectAndSpread({ prompt: 'deploy', maxTokens: 2000 }, [...softConstraints, hardDirective] as never, [])
    const loaded = [...res.directives, ...res.constraints].map(e => e.id)
    expect(loaded).toContain('ENG-HARD-DIR')
    expect(res.omitted_pinned.map(o => o.id)).not.toContain('ENG-HARD-DIR')
  })

  it('honours a configured pinned_hard_ratio', () => {
    const hard = Array.from({ length: 10 }, (_, i) => mk(`ENG-H-${i}`, { tier: 'hard', statement: 'h'.repeat(200) }))
    const out = fillTokenBudget(hard as never, 2000, 2000, { spent: 0 }, 0.1) // hard cap 100
    const used = out.selected.reduce((n, e) => n + estimateTokens(e), 0)
    expect(used).toBeLessThanOrEqual(100)
  })
})

describe('ratio guards', () => {
  it('a non-finite hard ratio falls back to the default instead of disabling the cap', () => {
    expect(pinnedHardCap(2000, NaN)).toBe(500)
    expect(pinnedHardCap(2000, Infinity)).toBe(500)
    const hard = Array.from({ length: 10 }, (_, i) => mk(`ENG-H-${i}`, { tier: 'hard', statement: 'h'.repeat(400) }))
    const out = fillTokenBudget(hard as never, 2000, 2000, { spent: 0 }, NaN)
    expect(out.selected.reduce((n, e) => n + estimateTokens(e), 0)).toBeLessThanOrEqual(500)
  })

  it('a non-finite pinned ratio falls back to the default', () => {
    expect(pinnedShareRatio(NaN)).toBe(0.5)
    expect(pinnedHardCap(2000, 0.5, NaN)).toBe(500)
  })

  it('selectAndSpread honours pinned_ratio', () => {
    const soft = Array.from({ length: 8 }, (_, i) => mk(`ENG-S-${i}`, { statement: `deploy rule ${i} ${'s'.repeat(300)}` }))
    const res = selectAndSpread({ prompt: 'deploy', maxTokens: 2000 }, soft as never, [], { pinned_ratio: 0.3 })
    const loaded = [...res.directives, ...res.constraints].map(e => e.id)
    const used = soft.filter(e => loaded.includes(e.id)).reduce((n, e) => n + estimateTokens(e as never), 0)
    expect(used).toBeLessThanOrEqual(600)
    expect(res.omitted_pinned.length).toBeGreaterThan(0)
  })
})
