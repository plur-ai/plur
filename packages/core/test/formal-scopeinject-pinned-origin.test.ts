/**
 * Formal-verification run (ScopeInject cluster, candidate 2): pinned origin
 * priority must hold across the section passes, not only within one.
 *
 * `pinnedOriginRank` ranks primary-store pins ahead of `stores:`/remote pins
 * ahead of installed-pack pins, and inject.ts calls that "a security control":
 * budget pressure must never let a pack pin in ahead of the user's own. The
 * rank was applied per fillTokenBudget call, and selection ran three calls
 * (constraints floor, directives, slack), so a pack pin in the directives pass
 * could take the pinned sub-budget a primary constraint pin needed.
 * Model: spec/formal/PlurSpec/ScopeInject.lean (`pinned_priority`).
 */
import { describe, it, expect } from 'vitest'
import { selectAndSpread, estimateTokens } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

const mk = (id: string, statement: string, extra: Record<string, unknown> = {}) => ({
  ...EngramSchema.parse({
    id, statement, type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: [],
    activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: '2026-09-20' },
  }),
  ...extra,
})
/** An engram whose estimated cost is exactly `tokens`. */
const sized = (id: string, tokens: number, extra: Record<string, unknown>) => {
  let e = mk(id, 'x', extra)
  while (estimateTokens(e as never) < tokens) e = mk(id, e.statement + 'y', extra)
  expect(estimateTokens(e as never)).toBe(tokens)
  return e
}
const pack = (name: string, engrams: unknown[]) =>
  ({ manifest: { name, version: '1' }, engrams }) as never

describe('pinned origin priority across section passes', () => {
  it('a pack pinned directive does not displace a primary pinned constraint', () => {
    const P = sized('ENG-2026-0920-101', 450, { pinned: true, polarity: 'dont' }) // primary, constraint
    const Q = sized('ENG-2026-0920-102', 300, { pinned: true, polarity: 'do' })   // pack, directive
    const r = selectAndSpread({ prompt: 'anything', maxTokens: 1000 }, [P], [pack('pk', [Q])])
    const got = [...r.directives, ...r.constraints].map(e => e.id)
    expect(got).toContain(P.id)
    expect(got).not.toContain(Q.id)
    expect(r.omitted_pinned.map(o => o.id)).toEqual([Q.id])
  })

  it('good case: both pins arrive when they fit the pinned sub-budget', () => {
    const P = sized('ENG-2026-0920-103', 300, { pinned: true, polarity: 'dont' })
    const Q = sized('ENG-2026-0920-104', 150, { pinned: true, polarity: 'do' })
    const r = selectAndSpread({ prompt: 'anything', maxTokens: 1000 }, [P], [pack('pk', [Q])])
    expect(r.constraints.map(e => e.id)).toEqual([P.id])
    expect(r.directives.map(e => e.id)).toEqual([Q.id])
    expect(r.omitted_pinned).toEqual([])
    expect(r.tokens_used.directives).toBe(450)
  })
})
