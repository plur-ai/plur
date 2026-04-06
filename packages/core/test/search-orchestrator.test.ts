import { describe, it, expect } from 'vitest'
import { recallAuto } from '../src/search-orchestrator.js'
import { EngramSchema } from '../src/schemas/engram.js'

describe('search orchestrator', () => {
  const makeEngram = (id: string, stmt: string) => EngramSchema.parse({
    id, statement: stmt, type: 'behavioral', scope: 'global', status: 'active',
  })

  const engrams = [
    makeEngram('ENG-2026-0406-001', 'Use port 3000 for dev'), makeEngram('ENG-2026-0406-002', 'Always check port availability'),
    makeEngram('ENG-2026-0406-003', 'Deploy using blue-green strategy'), makeEngram('ENG-2026-0406-004', 'Never deploy to production directly'),
    makeEngram('ENG-2026-0406-005', 'PostgreSQL is the primary database'),
  ]

  it('returns empty for no engrams', async () => {
    const r = await recallAuto([], 'test', 5)
    expect(r.results).toEqual([])
    expect(r.strategy_used).toBe('bm25')
  })

  it('returns results for keyword query', async () => {
    const r = await recallAuto(engrams, 'port 3000', 5)
    expect(r.results.length).toBeGreaterThan(0)
    expect(['bm25', 'hybrid']).toContain(r.strategy_used)
  })

  it('always returns results (fallback chain)', async () => {
    const r = await recallAuto(engrams, 'deploy production', 5)
    expect(r.results.length).toBeGreaterThan(0)
  })

  it('respects limit', async () => {
    const r = await recallAuto(engrams, 'deploy', 2)
    expect(r.results.length).toBeLessThanOrEqual(2)
  })

  it('includes strategy_used metadata', async () => {
    const r = await recallAuto(engrams, 'database', 5)
    expect(['bm25', 'hybrid', 'expanded', 'agentic']).toContain(r.strategy_used)
  })
})
