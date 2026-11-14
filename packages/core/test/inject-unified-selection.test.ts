/**
 * Unified selection (overhaul W1, R3, R6, D3, D4, W8 plumbing), unit level:
 * `selectUnified` is pure — the always-on slot, then the prohibition slice
 * from the ranked top 50, then the task list (recall's ranking, up to
 * `recall_limit`, skip-and-continue packing into what the pins and
 * prohibitions left), rendered into the three sections after selection.
 */
import { describe, it, expect } from 'vitest'
import { selectUnified } from '../src/inject-unified.js'
import { estimateTokens, isConstraintCandidate, selectAndSpread, MAX_PER_PACK } from '../src/inject.js'
import { EngramSchema, type Engram } from '../src/schemas/engram.js'

const today = new Date().toISOString().slice(0, 10)
const mk = (id: string, statement: string, extra: Record<string, unknown> = {}): Engram => ({
  ...EngramSchema.parse({
    id, statement, type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: [],
    activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: today },
  }),
  ...extra,
}) as Engram
const ids = (r: ReturnType<typeof selectUnified>) => [...r.directives, ...r.constraints, ...r.consider].map(e => e.id)

describe('selectUnified', () => {
  it('ranks by the recall search, not by keyword overlap with tags', () => {
    // The lookalike shares every common word and has matching tags (the legacy
    // keyword score favours it); the answer has the rare word.
    const answer = mk('ENG-2026-1001-001', 'the frobnik cache is flushed with the purge command')
    const look = Array.from({ length: 20 }, (_, i) => mk(`ENG-2026-1001-${String(i + 2).padStart(3, '0')}`,
      `cache rule ${i}: the cache command and the cache flush command for the cache`, { tags: ['cache', 'command', 'flush'] }))
    const r = selectUnified({ prompt: 'how is the frobnik cache flushed', maxTokens: 120 }, [...look, answer], [], { recall_limit: 3 })
    expect(ids(r)[0]).toBe(answer.id)
  })

  it('takes at most recall_limit task engrams', () => {
    const many = Array.from({ length: 30 }, (_, i) => mk(`ENG-2026-1002-${String(i + 1).padStart(3, '0')}`, `deploy step ${i} for the billing service`))
    const r = selectUnified({ prompt: 'deploy the billing service', maxTokens: 100_000 }, many, [], { recall_limit: 7 })
    expect(ids(r).length).toBe(7)
  })

  it('packing skips an engram that does not fit and continues (R6)', () => {
    const big = mk('ENG-2026-1003-001', `deploy billing service ${'with a very long explanation '.repeat(40)}`)
    const small = mk('ENG-2026-1003-002', 'deploy billing service with the script')
    const budget = estimateTokens(small as never) + 5
    const r = selectUnified({ prompt: 'deploy billing service', maxTokens: budget }, [big, small], [], { recall_limit: 10 })
    expect(ids(r)).toEqual([small.id])
  })

  it('the task list gets maxTokens − pinned_spent: an unused pin share flows to task matches (R6)', () => {
    const pin = mk('ENG-2026-1004-001', 'always be kind', { pinned: true })
    const tasks = Array.from({ length: 12 }, (_, i) => mk(`ENG-2026-1004-${String(i + 2).padStart(3, '0')}`, `deploy billing service step number ${i}`))
    const per = estimateTokens(tasks[0] as never)
    const pinCost = estimateTokens(pin as never)
    const maxTokens = pinCost + per * 8 + 2
    const r = selectUnified({ prompt: 'deploy billing service step', maxTokens }, [pin, ...tasks], [], { recall_limit: 10 })
    expect(ids(r)).toContain(pin.id)
    // Half the budget is the pin share; the pin used a sliver, the rest went to tasks.
    expect(ids(r).length - 1).toBe(8)
    expect(r.tokens_used.directives + r.tokens_used.consider).toBeLessThanOrEqual(maxTokens)
  })

  it('keeps the per-domain diversity cap (R6)', () => {
    const same = Array.from({ length: 15 }, (_, i) => mk(`ENG-2026-1005-${String(i + 1).padStart(3, '0')}`, `deploy billing note ${i}`, { domain: 'ops.deploy' }))
    const other = mk('ENG-2026-1005-099', 'deploy billing elsewhere', { domain: 'infra.deploy' })
    const r = selectUnified({ prompt: 'deploy billing', maxTokens: 100_000 }, [...same, other], [], { recall_limit: 16 })
    const opsCount = ids(r).filter(i => i.startsWith('ENG-2026-1005-0') && i !== other.id).length
    expect(opsCount).toBeLessThanOrEqual(10)
    expect(ids(r)).toContain(other.id)
  })

  it('prohibitions in the ranked top 50 get their slice before the general task list (D4)', () => {
    const dos = Array.from({ length: 10 }, (_, i) => mk(`ENG-2026-1006-${String(i + 1).padStart(3, '0')}`, `database migration tip ${i}: run the database migration in a transaction`))
    const dont = mk('ENG-2026-1006-050', 'never run a database migration on a friday', { polarity: 'dont' })
    const per = estimateTokens(dos[0] as never)
    // Room for roughly three entries: without the slice the prohibition (ranked
    // below the tips) would not get in.
    const maxTokens = per * 3 + 4
    const r = selectUnified({ prompt: 'database migration in a transaction', maxTokens }, [...dos, dont], [], { recall_limit: 10, prohibition_ratio: 0.5 })
    expect(ids(r)).toContain(dont.id)
    expect(r.constraints.map(e => e.id)).toContain(dont.id)
    const off = selectUnified({ prompt: 'database migration in a transaction', maxTokens }, [...dos, dont], [], { recall_limit: 10, prohibition_ratio: 0 })
    expect(ids(off)).not.toContain(dont.id)
  })

  it('pins without priority: prohibitions first, then oldest first (D3)', () => {
    const newer = mk('ENG-2026-1007-001', 'prefer short answers in chat', { pinned: true, created_at: '2026-05-01T00:00:00Z' })
    const older = mk('ENG-2026-1007-002', 'prefer british spelling in docs', { pinned: true, created_at: '2025-01-01T00:00:00Z' })
    const prohibit = mk('ENG-2026-1007-003', 'never push to the main branch', { pinned: true, polarity: 'dont', created_at: '2026-06-01T00:00:00Z' })
    const one = estimateTokens(prohibit as never)
    const two = one + estimateTokens(older as never)
    // Pin share = half; size the budget so exactly two pins fit the share.
    const r = selectUnified({ prompt: 'unrelated question about weather', maxTokens: two * 2 + 1 }, [newer, older, prohibit], [], { recall_limit: 0 })
    expect(ids(r).sort()).toEqual([prohibit.id, older.id].sort())
    expect(r.omitted_pinned.map(o => o.id)).toEqual([newer.id])
  })

  it('include_pinned: false gives no always-on slot, and pins never enter the task list', () => {
    const pin = mk('ENG-2026-1008-001', 'deploy billing with the pinned script', { pinned: true })
    const task = mk('ENG-2026-1008-002', 'deploy billing with care')
    const r = selectUnified({ prompt: 'deploy billing', maxTokens: 2000 }, [pin, task], [], { include_pinned: false })
    expect(ids(r)).toEqual([task.id])
    expect(r.omitted_pinned).toEqual([])
  })

  it('a superseded engram with no deliverable replacement takes ×0.3 before the cut (R3)', () => {
    const tip = mk('ENG-2026-1009-002', 'deploy using canary strategy two', { relations: { broader: [], narrower: [], related: [], conflicts: [], supersedes: [], superseded_by: [] } })
    const older = mk('ENG-2026-1009-001', 'deploy using canary strategy one canary', {
      relations: { broader: [], narrower: [], related: [], conflicts: [], supersedes: [], superseded_by: ['ENG-2026-1009-777'] },
    })
    // older matches better on keywords (two "canary"), but takes the penalty.
    const r = selectUnified({ prompt: 'deploy canary strategy', maxTokens: 2000 }, [older, tip], [], { recall_limit: 1 })
    expect(ids(r)).toEqual([tip.id])
  })

  it('returns per-injection relevance signals', () => {
    const a = mk('ENG-2026-1010-001', 'the frobnik cache is flushed with purge')
    const meaning = new Map([[a.id, 0.81]])
    const r = selectUnified({ prompt: 'frobnik cache flush', maxTokens: 2000 }, [a], [], {}, meaning)
    expect(r.relevance.top_fused).toBeGreaterThan(0)
    expect(r.relevance.top_cosine).toBeCloseTo(0.81)
    expect(r.relevance.top_keyword).toBeGreaterThan(0)
    expect(r.relevance.top_keyword).toBeLessThanOrEqual(1)
    expect(r.relevance.rank_gap).not.toBeNull()
    expect(r.relevance.reranker).toBeNull()
    expect(r.relevance.gated).toBe(false)
  })

  it('relevance gate (W8, default off): when nothing clears it the task section is empty, pins and prohibitions unchanged', () => {
    const pin = mk('ENG-2026-1011-001', 'always be kind', { pinned: true })
    const dont = mk('ENG-2026-1011-002', 'never deploy billing on fridays', { polarity: 'dont' })
    const task = mk('ENG-2026-1011-003', 'deploy billing with the script')
    const meaning = new Map([[dont.id, 0.4], [task.id, 0.42]])
    const ungated = selectUnified({ prompt: 'deploy billing', maxTokens: 2000 }, [pin, dont, task], [], {}, meaning)
    expect(ids(ungated).sort()).toEqual([pin.id, dont.id, task.id].sort())
    const gated = selectUnified({ prompt: 'deploy billing', maxTokens: 2000 }, [pin, dont, task], [],
      { min_relevance_signal: 'cosine', min_relevance: 0.9 }, meaning)
    expect(ids(gated).sort()).toEqual([pin.id, dont.id].sort())
    expect(gated.relevance.gated).toBe(true)
    // A threshold that is cleared changes nothing.
    const cleared = selectUnified({ prompt: 'deploy billing', maxTokens: 2000 }, [pin, dont, task], [],
      { min_relevance_signal: 'cosine', min_relevance: 0.3 }, meaning)
    expect(ids(cleared).sort()).toEqual(ids(ungated).sort())
  })

  it('renders the three sections after selection by isConstraintCandidate', () => {
    const rule = mk('ENG-2026-1012-001', 'deploy billing only from the release branch', { knowledge_type: { memory_class: 'procedural', cognitive_level: 'apply' } })
    const fact = mk('ENG-2026-1012-002', 'deploy billing takes ten minutes', { knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' } })
    const plain = mk('ENG-2026-1012-003', 'deploy billing with the script')
    const r = selectUnified({ prompt: 'deploy billing', maxTokens: 2000 }, [rule, fact, plain], [], {})
    expect(isConstraintCandidate(rule)).toBe(true)
    expect(r.constraints.map(e => e.id)).toEqual([rule.id])
    expect(r.consider.map(e => e.id)).toEqual([fact.id])
    expect(r.directives.map(e => e.id)).toEqual([plain.id])
  })

  it('an on_request pack is never a candidate; an on_match pack engram is ranked like any other', () => {
    const p1 = mk('ENG-2026-1013-001', 'deploy billing via the pack recipe')
    const p2 = mk('ENG-2026-1013-002', 'deploy billing via the hidden pack recipe')
    const packs = [
      { manifest: { name: 'open', version: '1' } as never, engrams: [p1] },
      { manifest: { name: 'closed', version: '1', 'x-datacore': { injection_policy: 'on_request' } } as never, engrams: [p2] },
    ] as never
    const r = selectUnified({ prompt: 'deploy billing pack recipe', maxTokens: 2000 }, [], packs, {})
    expect(ids(r)).toEqual([p1.id])
  })

  it('the deeper search does not stop before meaning-only candidates are offered (finding 9)', () => {
    // 120 candidates with no keyword hit; the meaning leg ranks 100 that are
    // each too big for the budget above 20 that fit. The keyword leg (3x
    // depth) covers the store long before the meaning leg (2x) does.
    const big = Array.from({ length: 100 }, (_, i) => mk(`ENG-2026-1101-${String(i + 1).padStart(3, '0')}`, `alpha note ${i} ${'with a very long explanation '.repeat(80)}`))
    const small = Array.from({ length: 20 }, (_, i) => mk(`ENG-2026-1102-${String(i + 1).padStart(3, '0')}`, `beta note ${i}`, { domain: `beta${i}` }))
    const meaning = new Map<string, number>([
      ...big.map((e, i) => [e.id, 0.9 - i * 0.001] as [string, number]),
      ...small.map((e, i) => [e.id, 0.5 - i * 0.001] as [string, number]),
    ])
    const r = selectUnified({ prompt: 'zzqx', maxTokens: 500 }, [...big, ...small], [], { recall_limit: 10 }, meaning)
    expect(r.task_count).toBe(10)
    expect(ids(r).every(i => i.startsWith('ENG-2026-1102-'))).toBe(true)
  })

  it('the per-pack cap counts pack rows by their _pack stamp, in unified and legacy selection (finding 8)', () => {
    const rows = Array.from({ length: 9 }, (_, i) => mk(`ENG-2026-1103-${String(i + 1).padStart(3, '0')}`, `deploy billing recipe step ${i}`, { domain: `d${i}` }))
    const packs = [{ manifest: { name: 'recipes', version: '1' } as never, engrams: rows }] as never
    const unified = selectUnified({ prompt: 'deploy billing recipe step', maxTokens: 100_000 }, [], packs, { recall_limit: 9 })
    expect(ids(unified).length).toBe(MAX_PER_PACK)
    const legacy = selectAndSpread({ prompt: 'deploy billing recipe step', maxTokens: 100_000 }, [], packs)
    const legacyIds = [...legacy.directives, ...legacy.constraints, ...legacy.consider].map(e => e.id)
    expect(legacyIds.length).toBeLessThanOrEqual(MAX_PER_PACK)
  })
})
