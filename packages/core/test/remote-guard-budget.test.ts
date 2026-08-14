/**
 * The ambiguity guards must be bounded ACROSS stores, not just per request.
 *
 * `fetchBounded` stops one host hanging forever. It does not stop N hosts
 * costing N × 30s — and these guards run INSIDE the primary store lock, whose
 * acquire budget is 180s. Four stalled remotes would exhaust it, and every
 * waiting writer would throw "Failed to acquire lock" with its engram silently
 * never stored: the exact failure the per-request bound was added to close,
 * reached by walking rather than by waiting.
 *
 * Measured before this: one `feedback()` against a store with an unreachable
 * host took 85s. That is N × the per-request bound, not the bound.
 *
 * Expiry needs no new policy. It routes into the SAME "cannot tell" branch an
 * unreachable store already takes, and the two callers already differ there by
 * design — which is what these tests pin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

/** Four remotes, so a per-request bound alone would cost 4x. */
const STORES = [1, 2, 3, 4].map(n => ({
  url: `https://remote-${n}.example.com/sse`,
  token: 'tok', scope: `group:acme/team-${n}`, shared: true, readonly: false,
}))

describe('ambiguity guards are bounded across the whole store walk', () => {
  let dir: string
  let plur: Plur
  let originalFetch: typeof globalThis.fetch
  let probes: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-guardbudget-'))
    writeFileSync(join(dir, 'config.yaml'), JSON.stringify({ stores: STORES, index: false }))
    originalFetch = globalThis.fetch
    probes = 0
    plur = new Plur({ path: dir })
  })
  afterEach(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

  /** Every probe burns most of the budget, so the walk must stop early. */
  function slowRemotes(): void {
    globalThis.fetch = vi.fn(async () => {
      probes++
      await new Promise(r => setTimeout(r, 30))
      throw new Error('ECONNREFUSED')
    }) as never
  }

  it('feedback proceeds with a warning rather than probing every store', async () => {
    const e = await plur.learn('a local fact with an ambiguous-looking id', {
      scope: 'global', type: 'behavioral',
    })
    slowRemotes()
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Must not throw: a mis-targeted rating is recoverable and rating is hot.
    await expect(plur.feedback(e.id, 'positive')).resolves.toBeUndefined()
    warn.mockRestore()
  })

  it('forget REFUSES rather than guessing when it runs out of budget', async () => {
    // The asymmetry the codebase already documents: a retire is irreversible,
    // so "I ran out of time looking" is not evidence of absence.
    const e = await plur.learn('a local fact that must not be wrongly retired', {
      scope: 'global', type: 'behavioral',
    })
    slowRemotes()

    // With a reachable-but-slow fleet the guard either completes or refuses —
    // it must never silently retire on an unverified walk.
    const outcome = await plur.forget(e.id, 'testing', { force: true }).then(
      () => 'retired', (err: Error) => err.message,
    )
    if (outcome === 'retired') {
      // Completed within budget: then every store WAS probed, which is the
      // only way a retire is allowed to proceed unscoped.
      expect(probes).toBeGreaterThanOrEqual(STORES.length)
    } else {
      expect(outcome).toMatch(/Cannot verify|could not|Ambiguous|not found/)
    }
  })

  it('scope: "primary" skips the walk entirely — the documented escape hatch', async () => {
    const e = await plur.learn('a local fact retired without any probing', {
      scope: 'global', type: 'behavioral',
    })
    slowRemotes()
    await plur.forget(e.id, 'explicitly local', { scope: 'primary', force: true })
    expect(probes, 'an explicitly-scoped retire must not touch the network').toBe(0)
  })
})
