/**
 * Keyword search tokenises each engram once per process, not three times per
 * query (IDF, mean length, score). On a 14k-engram store the repeats cost
 * ~4.5 s per unified injection and pushed the hook past its deadline.
 * The cache is keyed on the engram object and checked against its current
 * search text, so an edited engram is re-tokenised and results never change.
 */
import { describe, it, expect } from 'vitest'
import { engramTokens, engramTermSet, ftsTokenize, engramSearchText, searchEngramsScored } from '../src/fts.js'
import { EngramSchema } from '../src/schemas/engram.js'

const mk = (id: string, statement: string) => EngramSchema.parse({ id, statement, type: 'behavioral', scope: 'global', status: 'active' })

describe('engramTokens (per-process token cache)', () => {
  it('equals ftsTokenize of the search text and is reused on a second call', () => {
    const e = mk('ENG-2026-1114-001', 'deploy the service with kubernetes manifests')
    const a = engramTokens(e)
    expect(a).toEqual(ftsTokenize(engramSearchText(e)))
    expect(engramTokens(e)).toBe(a)
  })

  it('re-tokenises when the engram text changes', () => {
    const e = mk('ENG-2026-1114-002', 'deploy the service with kubernetes')
    const before = engramTokens(e)
    e.statement = 'rollback the database migration carefully'
    const after = engramTokens(e)
    expect(after).not.toBe(before)
    expect(after).toEqual(ftsTokenize(engramSearchText(e)))
  })

  it('search results are unchanged by the cache', () => {
    const es = [mk('ENG-2026-1114-003', 'deploy the app using kubernetes'), mk('ENG-2026-1114-004', 'kubernetes cluster configuration'), mk('ENG-2026-1114-005', 'write unit tests first')]
    const first = searchEngramsScored(es, 'kubernetes deploy', 5)
    const second = searchEngramsScored(es, 'kubernetes deploy', 5)
    expect(second.map(r => [r.engram.id, r.score, r.coverage])).toEqual(first.map(r => [r.engram.id, r.score, r.coverage]))
    expect(first[0].engram.id).toBe('ENG-2026-1114-003')
  })
})

describe('engramTermSet', () => {
  it('is the distinct tokens, cached, and refreshed on edit', () => {
    const e = mk('ENG-2026-1114-006', 'deploy deploy the service')
    const s1 = engramTermSet(e)
    expect([...s1].sort()).toEqual([...new Set(ftsTokenize(engramSearchText(e)))].sort())
    expect(engramTermSet(e)).toBe(s1)
    e.statement = 'rollback the migration'
    expect(engramTermSet(e)).not.toBe(s1)
    expect(engramTermSet(e).has('rollback')).toBe(true)
  })
})
