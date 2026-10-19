/**
 * Safety properties of the pinned two-tier model.
 *
 * The hard tier is a sub-cap inside the pinned quota (`hardTierCap()`,
 * default 0.5 × 1000 = 500 tokens). Every write path that can produce a
 * hard-tier engram must charge the SAME cost injection charges
 * (`estimateTokens`, the rendered text) against the SAME total, under the
 * store lock. These tests pin each path and the accounting itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { sanitizePackEngrams } from '../src/packs.js'
import { estimateTokens, formatLayer3, isHardPinned } from '../src/inject.js'
import type { Engram } from '../src/schemas/engram.js'

async function hardTotal(plur: Plur): Promise<number> {
  const hard = (await plur.listPinned()).filter(e => isHardPinned(e as never))
  return hard.reduce((sum, e) => sum + estimateTokens(e as never), 0)
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-pinned-cap-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('the hard-tier cap', () => {
  it('is a fraction of the pinned quota and never exceeds it', async () => {
    const plur = new Plur({ path: dir })
    const q = await plur.pinnedQuota()
    expect(plur.hardTierCap()).toBe(Math.floor(q.quota * 0.5))
    expect(plur.hardTierCap()).toBe(500)
  })

  it('honours a configured injection.pinned_hard_ratio', async () => {
    writeFileSync(join(dir, 'config.yaml'), 'injection:\n  pinned_hard_ratio: 0.2\n')
    const plur = new Plur({ path: dir })
    expect(plur.hardTierCap()).toBe(200)
  })

  it('holds under concurrent writes (committed total never exceeds it)', async () => {
    const plur = new Plur({ path: dir })
    // ~140 tokens each: three fit in 500, eight do not.
    const big = 'x'.repeat(500)
    const writes = Array.from({ length: 8 }, (_, i) =>
      plur.learn(`hard pinned fact ${i} ${big}`, { pinned: true, pin_tier: 'hard', scope: 'global' })
        .then(() => 'ok' as const)
        .catch((e: Error) => e.message))
    const results = await Promise.all(writes)
    const accepted = results.filter(r => r === 'ok').length
    expect(results.length - accepted, 'nothing was rejected — the cap did not bite').toBeGreaterThan(0)
    expect(accepted).toBeGreaterThan(0)
    const total = await hardTotal(plur)
    expect(total, `committed hard-tier total ${total} exceeds cap`).toBeLessThanOrEqual(plur.hardTierCap())
  })

  it('charges admission with the cost injection charges: a short statement with a huge rendered domain is refused', async () => {
    // The old admission estimate read only statement + rationale, so every
    // other rendered field was free at the door and paid for at injection.
    const plur = new Plur({ path: dir })
    await expect(plur.learn('short rule', {
      pinned: true, pin_tier: 'hard', scope: 'global', domain: 'd'.repeat(4000),
    })).rejects.toThrow(/Hard-tier pinned cap exceeded/)
    expect(await hardTotal(plur)).toBe(0)
  })

  it('near the cap, refuses a write whose rendered cost does not fit', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn(`anchor ${'a'.repeat(1400)}`, { pinned: true, pin_tier: 'hard', scope: 'global' })
    const used = await hardTotal(plur)
    expect(used).toBeGreaterThan(300)
    // Statement alone would fit; the rendered domain pushes it over.
    await expect(plur.learn('tiny', {
      pinned: true, pin_tier: 'hard', scope: 'global', domain: 'x'.repeat(4 * (plur.hardTierCap() - used)),
    })).rejects.toThrow(/Hard-tier pinned cap exceeded/)
    expect(await hardTotal(plur)).toBe(used)
  })

  it('many small writes never push the committed total past the cap', async () => {
    const plur = new Plur({ path: dir })
    let rejected = 0
    for (let i = 0; i < 40; i++) {
      try {
        await plur.learn(`small hard rule number ${i}`, { pinned: true, pin_tier: 'hard', scope: 'global', domain: 'ops.deploy' })
      } catch { rejected++ }
    }
    expect(rejected).toBeGreaterThan(0)
    expect(await hardTotal(plur)).toBeLessThanOrEqual(plur.hardTierCap())
  })

  it('does not charge unrendered fields — and they never reach the prompt', async () => {
    // An unrendered field costs nothing because no model sees it. The property
    // that matters is that the estimate bounds what is actually rendered, so
    // nothing caller-controlled can carry unbudgeted text into injection.
    const plur = new Plur({ path: dir })
    const huge = 'z'.repeat(400_000)
    const e = await plur.learn('rule with bulky metadata', {
      pinned: true, pin_tier: 'hard', scope: 'global',
      abstract: huge, tags: [huge], source: 'src', knowledge_anchors: [{ path: 'p', snippet: huge }],
    })
    const rendered = formatLayer3({ ...(e as object), confidence_score: 0.5 } as never)
    expect(rendered).not.toContain('zzzz')
    expect(rendered.length).toBeLessThanOrEqual(estimateTokens(e as never) * 4)
  })

  it('the estimate bounds the rendered text when every rendered field is large', () => {
    const big = 'q'.repeat(5000)
    const e = {
      id: 'ENG-2026-09-28-001', statement: big, rationale: big, domain: big,
      contraindications: [big, big], commitment: 'decided', claim_class: big,
      activation: { last_accessed: '2026-09-28' }, confidence_score: 0.5,
    }
    expect(formatLayer3(e as never).length).toBeLessThanOrEqual(estimateTokens(e as never) * 4)
  })
})

describe('the cap runs after dedup', () => {
  it('a re-learn that dedups into an existing hard-tier engram is not refused near the cap', async () => {
    const plur = new Plur({ path: dir })
    const statement = `the one hard rule ${'r'.repeat(1400)}`
    const first = await plur.learn(statement, { pinned: true, pin_tier: 'hard', scope: 'global' })
    // Fill the rest of the tier so a fresh write of the same size would not fit.
    expect((await hardTotal(plur)) * 2).toBeGreaterThan(plur.hardTierCap())
    const again = await plur.learn(statement, { pinned: true, pin_tier: 'hard', scope: 'global' })
    expect(again.id).toBe(first.id)
    expect(again.write_count).toBe(2)
  })
})

describe('every write path that can produce a hard-tier engram is capped', () => {
  it('learnRouted (local route) is capped', async () => {
    const plur = new Plur({ path: dir })
    await expect(plur.learnRouted('x', {
      pinned: true, pin_tier: 'hard', scope: 'global', domain: 'd'.repeat(4000),
    })).rejects.toThrow(/Hard-tier pinned cap exceeded/)
  })

  function withRemote(plur: Plur, append: () => Promise<{ id: string }>) {
    ;(plur as unknown as { _resolveRemoteStoreForScope: () => unknown })._resolveRemoteStoreForScope = () => ({
      appendAndGetServerId: append,
    })
  }

  it('learnRouted (remote route) refuses before POSTing', async () => {
    writeFileSync(join(dir, 'config.yaml'),
      'stores:\n  - scope: "group:acme/eng"\n    url: "https://example.invalid"\n    token: "t"\n')
    const plur = new Plur({ path: dir })
    let posts = 0
    withRemote(plur, async () => { posts++; return { id: 'ENG-2026-09-28-900' } })
    await expect(plur.learnRouted('x', {
      pinned: true, pin_tier: 'hard', scope: 'group:acme/eng', domain: 'd'.repeat(4000),
    })).rejects.toThrow(/Hard-tier pinned cap exceeded/)
    expect(posts).toBe(0)
    // A write that fits is POSTed.
    const ok = await plur.learnRouted('fits', { pinned: true, pin_tier: 'hard', scope: 'group:acme/eng' })
    expect(ok.id).toBe('ENG-2026-09-28-900')
    expect(posts).toBe(1)
  })

  it('learnRouted remote-failure fallback is capped and commits under the same lock', async () => {
    writeFileSync(join(dir, 'config.yaml'),
      'stores:\n  - scope: "group:acme/eng"\n    url: "https://example.invalid"\n    token: "t"\n')
    const plur = new Plur({ path: dir })
    withRemote(plur, async () => { throw new Error('remote down') })
    // Concurrent hard-tier writes whose POSTs all fail: every one would fall
    // back to a local save. The committed local total must still hold.
    const big = 'y'.repeat(500)
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      plur.learnRouted(`fallback ${i} ${big}`, { pinned: true, pin_tier: 'hard', scope: 'group:acme/eng' })
        .then(() => 'ok' as const).catch((e: Error) => e.message)))
    expect(results.filter(r => r !== 'ok').length).toBeGreaterThan(0)
    expect(results.filter(r => r === 'ok').length).toBeGreaterThan(0)
    expect(await hardTotal(plur)).toBeLessThanOrEqual(plur.hardTierCap())
  })

  it('unpin clears the tier and the priority', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('tiered', { pinned: true, pin_tier: 'hard', pinned_priority: 80, scope: 'global' })
    const off = await plur.setPinned(e.id, false) as unknown as Record<string, unknown>
    expect(off.pinned).toBeUndefined()
    expect('pinned_tier' in off).toBe(false)
    expect('pinned_priority' in off).toBe(false)
    const stored = await plur.getById(e.id) as unknown as Record<string, unknown>
    expect(stored.pinned_tier).toBeUndefined()
    expect(stored.pinned_priority).toBeUndefined()
  })

  it('re-pinning an engram that still carries pinned_tier: hard passes the cap', async () => {
    const plur = new Plur({ path: dir })
    // An engram whose tier survived an unpin (written before unpin cleared it,
    // or by another path) — the state setPinned must not trust.
    const big = 'b'.repeat(1400)
    const a = await plur.learn(`stale hard ${big}`, { pin_tier: 'hard', scope: 'global' })
    await plur.learn(`live hard ${big}`, { pinned: true, pin_tier: 'hard', scope: 'global' })
    await expect(plur.setPinned(a.id, true)).rejects.toThrow(/Hard-tier pinned cap exceeded/)
    expect((await plur.getById(a.id) as unknown as Record<string, unknown>).pinned).toBeUndefined()
    expect(await hardTotal(plur)).toBeLessThanOrEqual(plur.hardTierCap())
  })

  it('a remote re-pin that restores a hard tier over the cap is reverted and refused', async () => {
    writeFileSync(join(dir, 'config.yaml'),
      'stores:\n  - scope: "group:acme/eng"\n    url: "https://example.invalid"\n    token: "t"\n')
    const plur = new Plur({ path: dir })
    await plur.ready()
    const calls: Array<Record<string, unknown>> = []
    ;(plur as unknown as { _getRemoteDriver: () => unknown })._getRemoteDriver = () => ({
      patch: async (_id: string, body: Record<string, unknown>) => {
        calls.push(body)
        return {
          id: 'ENG-2026-09-28-500', statement: 'remote', scope: 'group:acme/eng', status: 'active',
          domain: 'd'.repeat(4000), pinned: body.pinned === true ? true : undefined, pinned_tier: 'hard',
          activation: { last_accessed: '2026-09-28' },
        }
      },
    })
    await expect(plur.setPinned('ENG-2026-09-28-500', true)).rejects.toThrow(/Hard-tier pinned cap exceeded/)
    expect(calls).toEqual([{ pinned: true }, { pinned: false }])
  })

  it('updateEngram cannot promote an engram into an over-cap hard tier', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn(`plain ${'u'.repeat(4000)}`, { scope: 'global' })
    await expect(plur.updateEngram({ ...e, pinned: true, pinned_tier: 'hard' } as Engram))
      .rejects.toThrow(/Hard-tier pinned cap exceeded/)
    // An update that does not grow the tier is always allowed.
    const h = await plur.learn('small hard', { pinned: true, pin_tier: 'hard', scope: 'global' })
    expect(await plur.updateEngram({ ...h, tags: ['x'] } as Engram)).toBe(true)
  })

  it('saveMetaEngrams counts earlier metas in the same batch', async () => {
    const plur = new Plur({ path: dir })
    const meta = (n: number): Engram => ({
      id: `ENG-META-${n}`, statement: `meta ${n} ${'m'.repeat(500)}`, type: 'behavioral', scope: 'global',
      status: 'active', pinned: true, pinned_tier: 'hard', activation: { last_accessed: '2026-09-28' },
    } as unknown as Engram)
    await expect(plur.saveMetaEngrams([1, 2, 3, 4, 5].map(meta))).rejects.toThrow(/Hard-tier pinned cap exceeded/)
    expect(await hardTotal(plur)).toBe(0)
  })
})

/**
 * An over-cap tier — reachable by LOWERING injection.pinned_hard_ratio after the
 * tier was filled — must not freeze the engrams already in it.
 */
describe('an over-cap tier does not block writes that cannot grow it', () => {
  async function overCapTier(): Promise<{ plur: Plur; a: Engram; b: Engram }> {
    const first = new Plur({ path: dir })
    const a = await first.learn(`hard rule A ${'a'.repeat(700)}`, { pinned: true, pin_tier: 'hard', scope: 'global' })
    const b = await first.learn(`hard rule B ${'b'.repeat(700)}`, { pinned: true, pin_tier: 'hard', scope: 'global' })
    writeFileSync(join(dir, 'config.yaml'), 'injection:\n  pinned_hard_ratio: 0.2\n')
    const plur = new Plur({ path: dir })
    expect(plur.hardTierCap()).toBe(200)
    expect(await hardTotal(plur)).toBeGreaterThan(plur.hardTierCap())
    return { plur, a, b }
  }

  it('changing an unrendered field (tags) on a hard engram succeeds', async () => {
    const { plur, b } = await overCapTier()
    expect(await plur.updateEngram({ ...b, tags: ['still-hard'] } as Engram)).toBe(true)
    expect((await plur.getById(b.id))!.tags).toEqual(['still-hard'])
  })

  it('retiring a hard engram via updateEngram succeeds even when the statement grows', async () => {
    const { plur, a } = await overCapTier()
    const grown = `${a.statement} ${'g'.repeat(800)}`
    expect(await plur.updateEngram({ ...a, statement: grown, status: 'retired' } as Engram)).toBe(true)
    expect((await plur.getById(a.id))!.status).toBe('retired')
  })

  it('editing an already-retired hard engram succeeds', async () => {
    const { plur, a } = await overCapTier()
    await plur.updateEngram({ ...a, status: 'retired' } as Engram)
    const retired = (await plur.getById(a.id))!
    expect(await plur.updateEngram({ ...retired, statement: `${retired.statement} ${'e'.repeat(900)}` } as Engram)).toBe(true)
  })
})

describe('admission and injection use the same pinned_ratio', () => {
  it('pinned_ratio 0.3 shrinks the injection pinned share to the quota', async () => {
    writeFileSync(join(dir, 'config.yaml'), 'injection:\n  pinned_ratio: 0.3\n')
    const plur = new Plur({ path: dir })
    const q = await plur.pinnedQuota()
    expect(q.quota).toBe(600)
    expect(plur.hardTierCap()).toBe(300)
    // ~900 tokens of soft pins: fits a 1000-token share, not a 600-token one.
    for (let i = 0; i < 6; i++) await plur.learn(`soft pinned rule ${i} ${'s'.repeat(560)}`, { pinned: true, scope: 'global' })
    const res = await plur.inject('anything at all')
    expect(res.omitted_pinned?.length ?? 0).toBeGreaterThan(0)
    const pinned = await plur.listPinned()
    const loaded = pinned.filter(e => res.injected_ids.includes(e.id))
    expect(loaded.reduce((n, e) => n + estimateTokens(e as never), 0)).toBeLessThanOrEqual(600)
  })

  it('with a larger pinned_ratio, every hard engram admitted at write time is injected', async () => {
    writeFileSync(join(dir, 'config.yaml'), 'injection:\n  pinned_ratio: 0.8\n')
    const plur = new Plur({ path: dir })
    expect(plur.hardTierCap()).toBe(800)
    const admitted: string[] = []
    for (let i = 0; i < 6; i++) {
      try {
        admitted.push((await plur.learn(`hard rule ${i} ${'h'.repeat(380)}`, { pinned: true, pin_tier: 'hard', scope: 'global' })).id)
      } catch { /* over the cap */ }
    }
    expect(await hardTotal(plur)).toBeGreaterThan(500) // more than the default-ratio hard cap would inject
    const res = await plur.inject('anything at all')
    expect((res.omitted_pinned ?? []).filter(o => o.reason === 'hard-tier-cap')).toEqual([])
    for (const id of admitted) expect(res.injected_ids).toContain(id)
  })
})

describe('remote re-pin records the prior state', () => {
  function remotePlur(driver: Record<string, unknown>): Plur {
    writeFileSync(join(dir, 'config.yaml'),
      'stores:\n  - scope: "group:acme/eng"\n    url: "https://example.invalid"\n    token: "t"\n')
    const plur = new Plur({ path: dir })
    ;(plur as unknown as { _getRemoteDriver: () => unknown })._getRemoteDriver = () => driver
    return plur
  }
  const overCapRow = (pinned: boolean) => ({
    id: 'ENG-2026-09-28-500', statement: 'remote', scope: 'group:acme/eng', status: 'active',
    domain: 'd'.repeat(4000), pinned: pinned || undefined, pinned_tier: 'hard',
    activation: { last_accessed: '2026-09-28' },
  })

  it('re-pinning an engram that was already pinned is not refused and not reverted', async () => {
    const calls: Array<Record<string, unknown>> = []
    const plur = remotePlur({
      getById: async () => overCapRow(true),
      patch: async (_id: string, body: Record<string, unknown>) => { calls.push(body); return overCapRow(body.pinned === true) },
    })
    await plur.ready()
    const res = await plur.setPinned('ENG-2026-09-28-500', true)
    expect(res?.pinned).toBe(true)
    expect(calls).toEqual([{ pinned: true }])
  })

  it('a failed revert is surfaced, not swallowed', async () => {
    const calls: Array<Record<string, unknown>> = []
    const plur = remotePlur({
      getById: async () => overCapRow(false),
      patch: async (_id: string, body: Record<string, unknown>) => {
        calls.push(body)
        if (body.pinned === false) throw new Error('Remote patch failed: 503')
        return overCapRow(true)
      },
    })
    await plur.ready()
    await expect(plur.setPinned('ENG-2026-09-28-500', true)).rejects.toThrow(/could NOT be reverted \(Remote patch failed: 503\)/)
    expect(calls).toEqual([{ pinned: true }, { pinned: false }])
  })
})

describe('pinned_priority and pin_tier are validated at learn', () => {
  it.each([0, 101, 9999, 1.5, -3])('rejects pinned_priority %s', async (p) => {
    const plur = new Plur({ path: dir })
    await expect(plur.learn('x', { pinned: true, pinned_priority: p, scope: 'global' }))
      .rejects.toThrow(/pinned_priority must be an integer from 1 to 100/)
  })

  it('accepts the bounds', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('one', { pinned: true, pinned_priority: 1, scope: 'global' })
    await plur.learn('hundred', { pinned: true, pinned_priority: 100, scope: 'global' })
  })

  it('rejects an unknown pin_tier', async () => {
    const plur = new Plur({ path: dir })
    await expect(plur.learn('x', { pinned: true, pin_tier: 'platinum' as never, scope: 'global' }))
      .rejects.toThrow(/invalid pin_tier/)
  })
})

describe('a pack cannot grant itself the hard tier', () => {
  it('strips pinned_tier and pinned_priority alongside pinned', () => {
    const { engrams, pinnedStripped, changed } = sanitizePackEngrams([{
      id: 'ENG-2026-0101-001', statement: 'trust me', pinned: true, pinned_tier: 'hard', pinned_priority: 9999,
    } as never])
    const out = engrams[0] as unknown as Record<string, unknown>
    expect(pinnedStripped).toBe(1)
    expect(changed).toBe(true)
    expect('pinned' in out).toBe(false)
    expect('pinned_tier' in out).toBe(false)
    expect('pinned_priority' in out).toBe(false)
  })

  it('strips the tier even when pinned itself was absent', () => {
    const { engrams, changed } = sanitizePackEngrams([{
      id: 'ENG-2026-0101-001', statement: 'x', pinned_tier: 'hard', pinned_priority: 9999,
    } as never])
    const out = engrams[0] as unknown as Record<string, unknown>
    expect(changed).toBe(true)
    expect('pinned_tier' in out).toBe(false)
    expect('pinned_priority' in out).toBe(false)
  })

  it('leaves an ordinary pack engram untouched', () => {
    const { changed } = sanitizePackEngrams([
      { id: 'ENG-2026-0101-001', statement: 'Prefer pnpm over npm', domain: 'build.tools' } as never,
    ])
    expect(changed).toBe(false)
  })
})
