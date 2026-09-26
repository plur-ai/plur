/**
 * Formal-verification run (ScopeInject cluster, candidate 1): every engram
 * `selectAndSpread` delivers must be VISIBLE under the inject's scope filter.
 *
 * `scoreEngram` returns 0 both for "excluded by scope" and for "no keyword
 * hits", and three later paths revived a 0: the pinned exemption, the
 * semantic-only embedding boost, and spreading activation (which looked a
 * target up in a map that held every active engram regardless of scope).
 * Model: spec/formal/PlurSpec/ScopeInject.lean (`selected_visible`).
 */
import { describe, it, expect } from 'vitest'
import { selectAndSpread } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

const mk = (id: string, scope: string, statement: string, extra: Record<string, unknown> = {}) => ({
  ...EngramSchema.parse({
    id, statement, type: 'behavioral', scope, status: 'active', version: 2, tags: [],
    activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: '2026-09-20' },
  }),
  ...extra,
})
const ids = (r: ReturnType<typeof selectAndSpread>) =>
  [...r.directives, ...r.constraints, ...r.consider].map(e => e.id)

const visible = mk('ENG-2026-0920-001', 'project:a', 'use the deploy script for releases')

describe('inject visibility — no path revives a scope-excluded engram', () => {
  it('a pinned engram in an ungranted shared scope is not injected under project scope', () => {
    const pin = mk('ENG-2026-0920-002', 'group:acme/other', 'secret team rule about payroll', { pinned: true })
    const r = selectAndSpread({ prompt: 'how to deploy releases', scope: 'project:a' }, [visible, pin], [])
    expect(ids(r)).toContain(visible.id)
    expect(ids(r)).not.toContain(pin.id)
  })

  it('INJECT_GLOBAL_IS_TARGETED holds for pinned engrams too', () => {
    const pinU = mk('ENG-2026-0920-003', 'user:x', 'personal pinned rule', { pinned: true })
    const g = mk('ENG-2026-0920-004', 'global', 'deploy with care')
    const r = selectAndSpread({ prompt: 'deploy', scope: 'global' }, [g, pinU], [])
    expect(ids(r)).toEqual([g.id])
  })

  it('a semantic-only embedding boost does not revive a scope-excluded engram', () => {
    const boosted = mk('ENG-2026-0920-005', 'group:acme/other', 'unrelated text here')
    const r = selectAndSpread({ prompt: 'how to deploy releases', scope: 'project:a' }, [visible, boosted], [],
      undefined, new Map([[boosted.id, 0.9]]))
    expect(ids(r)).not.toContain(boosted.id)
  })

  it('spreading activation does not reach a scope-excluded association target', () => {
    const hidden = mk('ENG-2026-0920-006', 'group:acme/other', 'hidden associated rule')
    const src = mk('ENG-2026-0920-007', 'project:a', 'use the deploy script for releases', {
      associations: [{ target_type: 'engram', target: hidden.id, type: 'semantic', strength: 0.9 }],
    })
    const r = selectAndSpread({ prompt: 'how to deploy releases', scope: 'project:a' }, [src, hidden], [])
    expect(ids(r)).toEqual([src.id])
    // Excluded by scope is neither retired nor unresolvable.
    expect(r.spread_drops).toBeUndefined()
  })

  it('a pack pinned engram in an excluded scope is not injected', () => {
    const packPin = mk('ENG-2026-0920-008', 'group:acme/other', 'pack pinned rule', { pinned: true })
    const r = selectAndSpread({ prompt: 'how to deploy releases', scope: 'project:a' }, [visible],
      [{ manifest: { name: 'p', version: '1' } as never, engrams: [packPin] } as never])
    expect(ids(r)).not.toContain(packPin.id)
  })

  it('good case: visible pinned, boosted and associated engrams still arrive', () => {
    const pin = mk('ENG-2026-0920-009', 'group:acme/eng', 'granted pinned rule', { pinned: true })
    const boosted = mk('ENG-2026-0920-010', 'user:me', 'unrelated text here')
    const assoc = mk('ENG-2026-0920-011', 'project:a:sub', 'associated visible rule')
    const src = mk('ENG-2026-0920-007', 'project:a', 'use the deploy script for releases', {
      associations: [{ target_type: 'engram', target: assoc.id, type: 'semantic', strength: 0.9 }],
    })
    const r = selectAndSpread(
      { prompt: 'how to deploy releases', scope: 'project:a', grantedScopes: ['group:acme/eng'] },
      [src, pin, boosted, assoc], [], undefined, new Map([[boosted.id, 0.9]]))
    expect(ids(r)).toEqual(expect.arrayContaining([src.id, pin.id, boosted.id, assoc.id]))
  })
})
