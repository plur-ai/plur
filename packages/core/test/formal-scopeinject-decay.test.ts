/**
 * Formal-verification run (ScopeInject cluster, candidate 7): decay must stay
 * finite and above its documented floor for any stored timestamp string.
 * Model: spec/formal/PlurSpec/ScopeInject.lean (§7).
 */
import { describe, it, expect } from 'vitest'
import { decayedStrength, daysSince, confidenceDecay } from '../src/decay.js'
import { selectAndSpread } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

describe('decay with an unparseable timestamp', () => {
  it('daysSince is finite (0) for an unparseable date', () => {
    expect(daysSince('yesterday-ish')).toBe(0)
    expect(Number.isFinite(decayedStrength(0.8, daysSince('yesterday-ish')))).toBe(true)
  })

  it('confidenceDecay honours its floor instead of returning NaN', () => {
    const v = confidenceDecay(0.8, 'garbage', undefined, undefined)
    expect(Number.isFinite(v)).toBe(true)
    expect(v).toBeGreaterThanOrEqual(0.1)
    expect(confidenceDecay(0.8, null, undefined, 'garbage')).toBe(0.8)
  })

  it('an engram with a malformed last_accessed is still injected', () => {
    const mk = (id: string, last: string) => EngramSchema.parse({
      id, statement: 'deploy with the release script', type: 'behavioral', scope: 'global', status: 'active',
      version: 2, tags: [], activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: last },
    })
    const bad = mk('ENG-2026-0920-601', 'yesterday-ish')
    const ok = mk('ENG-2026-0920-602', '2026-09-20')
    const r = selectAndSpread({ prompt: 'deploy release script' }, [bad as never, ok as never], [])
    expect([...r.directives, ...r.constraints, ...r.consider].map(e => e.id)).toContain(bad.id)
  })

  it('good case: valid dates still decay', () => {
    const now = new Date('2026-03-19T00:00:00Z')
    expect(daysSince('2026-03-18', now)).toBe(1)
    expect(decayedStrength(1.0, 180)).toBeLessThan(decayedStrength(1.0, 1))
    expect(confidenceDecay(0.8, '2025-01-01', undefined, undefined, now)).toBeLessThan(0.8)
  })
})
