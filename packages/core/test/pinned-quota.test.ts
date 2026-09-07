/**
 * Pinned budget is a QUOTA checked when pinning, not a cap applied silently
 * at injection time — #1142.
 *
 * The spec calls `pinned` an "always-load flag". The selector did not honour
 * that: it capped pinned engrams at a share of the injection budget and
 * skipped the overflow without a word, so pinning one thing could quietly
 * evict another thing the user had also pinned. Measured on a real store,
 * lowering `injection_budget` from 56,000 to 12,000 dropped 36 of 46 pinned
 * engrams, chosen by score rather than by importance.
 *
 * The fix is not a smarter eviction rule. It is to stop over-committing:
 * pinning is a deliberate act performed with a human present, so the quota is
 * enforced there, where "unpin one or raise the limit" is a question someone
 * can actually answer.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { EngramSchema } from '../src/schemas/engram.js'
import { fillTokenBudget, pinnedOriginRank } from '../src/inject.js'

describe('pinned quota (#1142)', () => {
  const dirs: string[] = []
  // Config is loaded from <store>/config.yaml, not from a constructor option,
  // so the budget under test has to be written to disk before the instance is
  // built. Passing it to the constructor silently falls back to the defaults
  // (injection_budget 2000), which is what made the first run of these tests
  // assert against a quota nobody had configured.
  const freshPlur = (budget: number, ratio: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-pinquota-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'config.yaml'),
      `injection_budget: ${budget}\ninjection:\n  pinned_ratio: ${ratio}\n`)
    return new Plur({ path: dir })
  }
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

  const pinMany = async (plur: Plur, n: number, filler = 30) => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const r = await plur.learn(
        `Never deploy on a Friday, rule ${i}. ${'deploy '.repeat(filler)}`,
        { scope: 'global' },
      ) as { id: string }
      await plur.setPinnedAsync(r.id, true)
      ids.push(r.id)
    }
    return ids
  }

  it('derives the quota from injection_budget × pinned_ratio', async () => {
    const plur = freshPlur(1000, 0.5)
    const q = await plur.pinnedQuota()
    expect(q.quota).toBe(500)
    expect(q.used).toBe(0)
    expect(q.over).toBe(false)
  })

  it('honours a configured pinned_ratio', async () => {
    // Previously this key was stripped by the config schema and the hardcoded
    // 0.5 used instead, so the knob silently did nothing.
    const plur = freshPlur(1000, 0.25)
    expect((await plur.pinnedQuota()).quota).toBe(250)
  })

  it('reports an over-committed set rather than hiding it', async () => {
    const plur = freshPlur(1000, 0.5)
    await pinMany(plur, 6)
    const q = await plur.pinnedQuota()
    expect(q.count).toBe(6)
    expect(q.used).toBeGreaterThan(q.quota)
    expect(q.over).toBe(true)
    expect(q.free).toBe(0)
    expect(q.entries).toHaveLength(6)
  })

  it('prices a candidate before it is pinned', async () => {
    const plur = freshPlur(100000, 0.5)
    const r = await plur.learn('Never force-push to a protected branch', { scope: 'global' }) as { id: string }
    const q = await plur.pinnedQuota(r.id)
    expect(q.candidate?.id).toBe(r.id)
    expect(q.candidate?.cost).toBeGreaterThan(0)
    expect(q.candidate?.fits).toBe(true)
    expect(q.candidate?.would_be).toBe(q.used + (q.candidate?.cost ?? 0))
  })

  it('marks a candidate that would not fit', async () => {
    const plur = freshPlur(400, 0.5)
    await pinMany(plur, 2)
    const r = await plur.learn('Never skip the rollback plan before a release', { scope: 'global' }) as { id: string }
    const q = await plur.pinnedQuota(r.id)
    expect(q.candidate?.fits).toBe(false)
    expect(q.candidate?.would_be).toBeGreaterThan(q.quota)
  })

  it('does not charge a re-pin of something already pinned', async () => {
    // A no-op re-pin must not be treated as a new commitment, or the quota
    // check would refuse an engram that is already inside it.
    const plur = freshPlur(100000, 0.5)
    const [id] = await pinMany(plur, 1)
    const q = await plur.pinnedQuota(id)
    expect(q.candidate).toBeUndefined()
  })

  it('orders entries by cost, not by a guessed expendability', async () => {
    // An earlier version sorted by net feedback ascending. Against a real
    // store that proposed unpinning the demo-redaction rule and two
    // client-confidentiality rules, because only ~4% of engrams carry any
    // feedback at all and the rest tie at zero. Cost is arithmetic; the
    // judgement stays with the user.
    const plur = freshPlur(100000, 0.5)
    await pinMany(plur, 2, 10)
    await pinMany(plur, 1, 90)
    const q = await plur.pinnedQuota()
    const costs = q.entries.map(e => e.cost)
    expect(costs).toEqual([...costs].sort((a, b) => b - a))
    // The signals are still reported, they are just not the sort key.
    expect(q.entries[0]).toHaveProperty('net_feedback')
    expect(q.entries[0]).toHaveProperty('last_accessed')
  })
})

describe('pinned origin ranking (#1121, adopted)', () => {
  // `pinned` bypasses the relevance gate, so the key that orders pins is a
  // security control: without it an installed pack could fill the pinned
  // budget and displace the user's own always-load rules.
  const mk = (id: string, marker: Record<string, unknown> = {}) => ({
    ...EngramSchema.parse({
      id, statement: `Never deploy on a Friday, rule ${id}. ${'deploy '.repeat(20)}`,
      type: 'behavioral', scope: 'global', status: 'active', pinned: true,
    }),
    keyword_match: 1, raw_score: 1, score: 1,
    ...marker,
  })

  it('ranks a primary pin ahead of a pack pin under budget pressure', () => {
    const fromPack = mk('ENG-2026-1121-001', { _pack: 'some-installed-pack' })
    const primary = mk('ENG-2026-1121-002')
    // Budget fits exactly one.
    const out = fillTokenBudget([fromPack, primary] as never, 170)
    expect(out.selected.map(e => e.id)).toEqual(['ENG-2026-1121-002'])
    expect(out.omitted_pinned.map(o => o.id)).toContain('ENG-2026-1121-001')
  })

  it('ranks a remote/store pin ahead of a pack pin', () => {
    const fromPack = mk('ENG-2026-1121-003', { _pack: 'p' })
    const fromStore = mk('ENG-2026-1121-004', { _storeScope: 'group:org/team' })
    const out = fillTokenBudget([fromPack, fromStore] as never, 170)
    expect(out.selected.map(e => e.id)).toEqual(['ENG-2026-1121-004'])
  })

  it('a row cannot claim primary origin by shipping its own marker', () => {
    // Markers are loader-stamped. A row carrying _pack can only rank itself
    // lower; there is no marker it can set to become primary.
    expect(pinnedOriginRank({ _pack: 'x' })).toBe(2)
    expect(pinnedOriginRank({ _storeScope: 's' })).toBe(1)
    expect(pinnedOriginRank({})).toBe(0)
  })

  it('does not admit a lower-origin pin after skipping a higher-origin one', () => {
    // #1124: selection was greedy, so a large primary pin could be skipped for
    // size while smaller pack pins were still admitted after it.
    const bigPrimary = { ...mk('ENG-2026-1121-005'), statement: 'x'.repeat(4000) }
    const smallPack = mk('ENG-2026-1121-006', { _pack: 'p' })
    const out = fillTokenBudget([bigPrimary, smallPack] as never, 200)
    expect(out.selected.map(e => e.id)).not.toContain('ENG-2026-1121-006')
    expect(out.omitted_pinned.map(o => o.id)).toEqual(
      expect.arrayContaining(['ENG-2026-1121-005', 'ENG-2026-1121-006']))
  })
})
