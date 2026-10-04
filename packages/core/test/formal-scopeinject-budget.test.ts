/**
 * Formal-verification run (ScopeInject cluster, candidate 5): the injection
 * budget is charged per engram by `estimateTokens`, which must never charge
 * less than what the formatter actually emits for that engram.
 * Model: spec/formal/PlurSpec/ScopeInject.lean (`estimate_covers_render`).
 */
import { describe, it, expect } from 'vitest'
import { estimateTokens, formatLayer1, formatLayer3, selectAndSpread } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

const base = {
  type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: ['deploy'],
  activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: '2026-09-20T10:11:12.000Z' },
}

describe('estimateTokens covers the rendered entry', () => {
  it('charges for Kind: and the soft-expiry marker (layer 3)', () => {
    const e = {
      ...EngramSchema.parse({ ...base, id: 'ENG-2026-0920-201', statement: 'Deploy only from main',
        domain: 'ops.deploy', temporal: { learned_at: '2026-08-01', valid_until: '2026-09-01' } }),
      claim_class: 'inferred', commitment: 'leaning',
    }
    const r = selectAndSpread({ prompt: 'deploy', maxTokens: 5000 }, [e as never], [],
      { expiry: { mode: 'soft', grace_days: 3650 } })
    const wire = [...r.directives, ...r.constraints][0]
    const out = formatLayer3(wire)
    expect(out).toContain('EXPIRED')
    expect(out).toContain('Kind: inferred')
    expect(estimateTokens(e as never) * 4).toBeGreaterThanOrEqual(out.length)
  })

  it('charges for an untruncated summary (layer 1, the consider bucket)', () => {
    const e = {
      ...EngramSchema.parse({ ...base, id: 'ENG-2026-0920-202', statement: 'Short rule text' }),
      summary: 'A summary that is much longer than the statement it summarises, written by a consolidation pass',
    }
    const out = formatLayer1({ ...e, confidence_score: 0.5 } as never)
    expect(estimateTokens(e as never) * 4).toBeGreaterThanOrEqual(out.length)
  })

  it('good case: a plain engram costs about its rendered length', () => {
    const e = EngramSchema.parse({ ...base, id: 'ENG-2026-0920-203', statement: 'Deploy only from main' })
    const out = formatLayer3({ ...e, confidence_score: 0.5 } as never)
    const est = estimateTokens(e as never)
    expect(est * 4).toBeGreaterThanOrEqual(out.length)
    expect(est * 4).toBeLessThan(out.length + 24)
  })
})
