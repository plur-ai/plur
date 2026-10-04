import { describe, it, expect } from 'vitest'
import { selectAndSpread } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

// A session scoped to one project must not receive another project's engrams.
// `scoreEngram` returns 0 for an engram outside the scope, but 0 is also what
// it returns for "no keyword overlap" — and selectAndSpread turned any 0 with
// an embedding boost above 0.5 into a positive score. So the BM25-only
// inject() honoured the scope while injectHybrid() — what the prompt hook
// calls — let a semantically similar engram from another project straight
// back in. Spreading activation had the same hole through associations.
describe('scope filter survives embedding boosts and spreading activation', () => {
  const make = (overrides: Partial<any>) => EngramSchema.parse({
    type: 'behavioral', status: 'active', ...overrides,
  })
  const allIds = (result: ReturnType<typeof selectAndSpread>) => [
    ...result.directives.map(e => e.id),
    ...result.constraints.map(e => e.id),
    ...result.consider.map(e => e.id),
  ]
  const other = () => make({ id: 'ENG-2026-0103-001', scope: 'project:b', statement: 'Meridian trades settle in USDC on Solana' })
  const mine = () => make({ id: 'ENG-2026-0103-002', scope: 'project:a', statement: 'Trades in this project settle weekly' })
  const shared = () => make({ id: 'ENG-2026-0103-003', scope: 'global', statement: 'Commit messages use the imperative mood' })

  it('an embedding boost does not admit an engram from another project scope', () => {
    const boosts = new Map([['ENG-2026-0103-001', 0.9], ['ENG-2026-0103-002', 0.9], ['ENG-2026-0103-003', 0.9]])
    const result = selectAndSpread(
      { prompt: 'how do payments clear', scope: 'project:a', maxTokens: 5000 },
      [other(), mine(), shared()], [], undefined, boosts,
    )
    const ids = allIds(result)
    expect(ids).toContain('ENG-2026-0103-002')
    expect(ids).toContain('ENG-2026-0103-003')
    expect(ids).not.toContain('ENG-2026-0103-001')
  })

  it('the same boosted engram is admitted in its own scope (control)', () => {
    const boosts = new Map([['ENG-2026-0103-001', 0.9]])
    const result = selectAndSpread(
      { prompt: 'how do payments clear', scope: 'project:b', maxTokens: 5000 },
      [other(), shared()], [], undefined, boosts,
    )
    expect(allIds(result)).toContain('ENG-2026-0103-001')
  })

  it('spreading activation does not reach an engram from another project scope', () => {
    const g = shared()
    g.associations = [{ target_type: 'engram', target: 'ENG-2026-0103-001', type: 'co_accessed', strength: 0.9, updated_at: new Date().toISOString().slice(0, 10) }] as any
    const result = selectAndSpread(
      { prompt: 'commit messages imperative mood', scope: 'project:a', maxTokens: 5000 },
      [other(), g], [],
    )
    const ids = allIds(result)
    expect(ids).toContain('ENG-2026-0103-003')
    expect(ids).not.toContain('ENG-2026-0103-001')
  })

  it('an embedding boost does not admit a pack engram from another project scope', () => {
    // The pack loop has its own scope filter; the personal-loop tests above do
    // not reach it.
    const boosts = new Map([['ENG-2026-0103-001', 0.9], ['ENG-2026-0103-003', 0.9]])
    const pack = {
      manifest: { name: 'p', version: '1.0.0', metadata: { injection_policy: 'on_match', match_terms: [] } },
      engrams: [other(), shared()],
    } as never
    const result = selectAndSpread(
      { prompt: 'how do payments clear', scope: 'project:a', maxTokens: 5000 },
      [], [pack], undefined, boosts,
    )
    const ids = allIds(result)
    expect(ids).toContain('ENG-2026-0103-003')
    expect(ids).not.toContain('ENG-2026-0103-001')
  })

  it('an out-of-scope association target is filtered, not counted as a spread drop', () => {
    // The target exists locally but is out of scope: it is not missing and not
    // retired, so spread_drops must not report it. A genuinely missing target
    // on the same engram is still counted, which proves the accounting runs.
    const g = shared()
    const today = new Date().toISOString().slice(0, 10)
    g.associations = [
      { target_type: 'engram', target: 'ENG-2026-0103-001', type: 'co_accessed', strength: 0.9, updated_at: today },
      { target_type: 'engram', target: 'ENG-2026-0103-999', type: 'co_accessed', strength: 0.9, updated_at: today },
    ] as any
    const result = selectAndSpread(
      { prompt: 'commit messages imperative mood', scope: 'project:a', maxTokens: 5000 },
      [other(), g], [],
    )
    expect(allIds(result)).not.toContain('ENG-2026-0103-001')
    expect(result.spread_drops).toEqual({ dropped_unresolvable: 1, dropped_retired: 0 })
  })
})
