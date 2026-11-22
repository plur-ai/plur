/**
 * When recall ranks a memory that injection must not deliver because a
 * deliverable memory replaces it, the replacement takes its place in the
 * order. Otherwise a corrected rule found by its old wording delivers
 * nothing at all: the old one is dropped and the correction never ranked.
 */
import { describe, it, expect } from 'vitest'
import { buildUnifiedPool, orderRecallCandidates } from '../src/inject-unified.js'
import { EngramSchema, type Engram } from '../src/schemas/engram.js'

const today = new Date().toISOString().slice(0, 10)
const mk = (id: string, statement: string, extra: Record<string, unknown> = {}): Engram => ({
  ...EngramSchema.parse({
    id, statement, type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: [],
    activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: today },
  }),
  ...extra,
}) as Engram

describe('unified order: a replaced memory hands its place to its replacement', () => {
  const old = mk('ENG-2026-3001-001', 'Publish straight from the laptop', { relations: { superseded_by: ['ENG-2026-3001-002'] } })
  const neu = mk('ENG-2026-3001-002', 'Publish only from a signed tag in CI', { relations: { supersedes: ['ENG-2026-3001-001'] } })
  const other = mk('ENG-2026-3001-003', 'Release checklists live next to the changelog')
  const pool = buildUnifiedPool({ prompt: 'publish laptop' }, [old, neu, other], [])

  it('the pool leaves the replaced memory out', () => {
    expect(pool.candidates.map(e => e.id)).toEqual([neu.id, other.id])
  })

  it('recall ranking only the old memory still delivers the replacement, in its place', () => {
    const ranked = orderRecallCandidates([old.id, other.id], pool, new Map())
    expect(ranked.map(c => c.engram.id)).toEqual([neu.id, other.id])
  })

  it('a replacement recall also ranked later appears once, at the earlier place', () => {
    const ranked = orderRecallCandidates([old.id, other.id, neu.id], pool, new Map())
    expect(ranked.map(c => c.engram.id)).toEqual([neu.id, other.id])
  })

  it('without replacements the order is recall\'s', () => {
    const ranked = orderRecallCandidates([other.id, neu.id], pool, new Map())
    expect(ranked.map(c => c.engram.id)).toEqual([other.id, neu.id])
  })
})
