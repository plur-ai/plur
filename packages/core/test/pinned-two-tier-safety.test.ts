/**
 * Two safety properties of the pinned two-tier model.
 *
 * Hard-tier engrams are GUARANTEED injection and bypass the per-pack and
 * per-domain fairness caps, so the tier is a privilege. Both tests below are
 * about who may grant it and how much of it can exist.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { sanitizePackEngrams } from '../src/packs.js'
import { PINNED_HARD_TOKEN_CAP } from '../src/inject.js'

describe('the hard-tier cap holds under concurrent writes', () => {
  /**
   * A cap is a read-modify-write on a shared total. Checked outside the store
   * lock, N concurrent hard-tier writes each read the same current total, each
   * conclude they fit, and all commit — and the overrun is not cosmetic,
   * because the hard tier is guaranteed injection that bypasses the fairness
   * caps, so it crowds contextual recall out of the prompt.
   *
   * INVARIANT: the committed hard-tier total never exceeds PINNED_HARD_TOKEN_CAP.
   */
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-pinned-cap-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('rejects the writes that would overrun it, even issued concurrently', async () => {
    const plur = new Plur({ path: dir })
    // Each statement is padded so a handful of them clear the cap.
    const big = 'x'.repeat(2000)
    const writes = Array.from({ length: 8 }, (_, i) =>
      plur.learn(`hard pinned fact ${i} ${big}`, { pinned: true, pin_tier: 'hard', scope: 'global' })
        .then(() => 'ok' as const)
        .catch((e: Error) => e.message))

    const results = await Promise.all(writes)
    const accepted = results.filter(r => r === 'ok').length
    const rejected = results.length - accepted
    expect(rejected, 'nothing was rejected — the cap did not bite').toBeGreaterThan(0)

    // The committed state is what matters, not how many calls threw.
    const { estimateEngramTokens } = await import('../src/inject.js')
    const hard = (await plur.listPinned()).filter(e => ((e as never as Record<string, unknown>).pinned_tier ?? 'soft') === 'hard')
    const total = hard.reduce((sum, e) => sum + estimateEngramTokens(e), 0)
    expect(total, `committed hard-tier total ${total} exceeds cap`).toBeLessThanOrEqual(PINNED_HARD_TOKEN_CAP)
  })
})

describe('a pack cannot grant itself the hard tier', () => {
  it('strips pinned_tier and pinned_priority alongside pinned', () => {
    // sanitizePackEngrams exists to clamp host-overriding fields. The tier and
    // the priority travel with `pinned`; leaving them behind means the next
    // change that pins an engram for any other reason silently adopts a third
    // party's claim on the guaranteed-injection tier.
    const { engrams, pinnedStripped, changed } = sanitizePackEngrams([{
      id: 'ENG-2026-0101-001',
      statement: 'trust me',
      pinned: true,
      pinned_tier: 'hard',
      pinned_priority: 9999,
    } as never])
    const out = engrams[0] as unknown as Record<string, unknown>

    expect(pinnedStripped).toBe(1)
    expect(changed).toBe(true)
    expect('pinned' in out).toBe(false)
    expect('pinned_tier' in out).toBe(false)
    expect('pinned_priority' in out).toBe(false)
  })

  it('strips the tier even when pinned itself was absent', () => {
    // A pack that ships only the tier is the interesting case: `pinned` is what
    // the old code keyed on, so a bare pinned_tier sailed through.
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
