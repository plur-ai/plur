import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { getCandidatePairs, scanForTensions, type TensionPair } from '../src/tensions.js'
import { generateTensionId, tensionPairKey, categorizeTension } from '../src/tension-store.js'
import { readHistory } from '../src/history.js'
import type { Engram } from '../src/schemas/engram.js'

/**
 * Tension lifecycle (#181): persistence, suppress-list, confirm/dismiss/
 * resolve, injection warnings, lock-escalation gate. Directly implements the
 * must-have items 1–4 of the #213 audit.
 */

function pairOf(a: { id: string; statement: string }, b: { id: string; statement: string }, extra?: Partial<TensionPair>): TensionPair {
  return {
    id_a: a.id,
    id_b: b.id,
    statement_a: a.statement,
    statement_b: b.statement,
    confidence: 0.9,
    reason: 'Mutually exclusive claims.',
    ...extra,
  }
}

describe('tension persistence (#181)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-tension-lc-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('recordTensions persists records to tensions.yaml and survives a fresh instance', () => {
    const a = plur.learn('plur cli version is 0.3.0')
    const b = plur.learn('plur cli version is 0.8.2')
    const { records, new_count } = plur.recordTensions([pairOf(a, b)])

    expect(new_count).toBe(1)
    expect(records[0].id).toMatch(/^T-\d{4}-\d{4}-\d{3}$/)
    expect(records[0].status).toBe('detected')
    expect(existsSync(join(dir, 'tensions.yaml'))).toBe(true)

    const plur2 = new Plur({ path: dir })
    const reloaded = plur2.listTensions()
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0].id).toBe(records[0].id)
    expect(reloaded[0].statement_a).toBe(a.statement)
  })

  it('does not duplicate an already-recorded pair (either direction)', () => {
    const a = plur.learn('plur cli version is 0.3.0')
    const b = plur.learn('plur cli version is 0.8.2')
    const first = plur.recordTensions([pairOf(a, b)])
    expect(first.new_count).toBe(1)

    // Same pair again — and reversed
    const again = plur.recordTensions([pairOf(a, b), pairOf(b, a)])
    expect(again.new_count).toBe(0)
    expect(again.existing_count).toBe(2)
    expect(plur.listTensions()).toHaveLength(1)
  })

  it('emits the contradiction_detected history event on new records (audit C5)', () => {
    const a = plur.learn('plur cli version is 0.3.0')
    const b = plur.learn('plur cli version is 0.8.2')
    plur.recordTensions([pairOf(a, b)])

    const month = new Date().toISOString().slice(0, 7)
    const events = readHistory(dir, month).filter(e => e.event === 'contradiction_detected')
    expect(events).toHaveLength(1)
    expect(events[0].engram_id).toBe(a.id)
    expect((events[0].data as any).engram_b).toBe(b.id)
    expect((events[0].data as any).tension_id).toMatch(/^T-/)
  })

  it('status().tension_count counts unresolved persisted records (audit C2)', () => {
    const a = plur.learn('plur cli version is 0.3.0')
    const b = plur.learn('plur cli version is 0.8.2')
    expect(plur.status().tension_count).toBe(0)

    const { records } = plur.recordTensions([pairOf(a, b)])
    expect(plur.status().tension_count).toBe(1)

    plur.dismissTension(records[0].id)
    expect(plur.status().tension_count).toBe(0)
  })

  it('listTensions filters by status', () => {
    const a = plur.learn('plur cli version is 0.3.0')
    const b = plur.learn('plur cli version is 0.8.2')
    const c = plur.learn('plur uses yaml storage')
    const d = plur.learn('plur uses json storage')
    const { records } = plur.recordTensions([pairOf(a, b), pairOf(c, d)])
    plur.dismissTension(records[1].id)

    expect(plur.listTensions({ status: ['detected'] })).toHaveLength(1)
    expect(plur.listTensions({ status: ['dismissed'] })).toHaveLength(1)
    expect(plur.listTensions()).toHaveLength(2)
  })
})

describe('tension id + category helpers (#181)', () => {
  it('generateTensionId numbers per day', () => {
    const now = new Date('2026-07-03T10:00:00Z')
    expect(generateTensionId([], now)).toBe('T-2026-0703-001')
    const existing = [
      { id: 'T-2026-0703-002' }, { id: 'T-2026-0702-009' },
    ] as any
    expect(generateTensionId(existing, now)).toBe('T-2026-0703-003')
  })

  it('tensionPairKey is order-independent', () => {
    expect(tensionPairKey('B', 'A')).toBe(tensionPairKey('A', 'B'))
  })

  it('categorize: "(not X)" pattern → superseded', () => {
    expect(categorizeTension('war analysis uses 9 agents (not 5)', 'war analysis uses 5 agents')).toBe('superseded')
  })

  it('categorize: different recorded dates → temporal', () => {
    const a = { id: 'ENG-2026-0407-001', temporal: { learned_at: '2026-04-07' } } as unknown as Engram
    const b = { id: 'ENG-2026-0413-002', temporal: { learned_at: '2026-04-13' } } as unknown as Engram
    expect(categorizeTension('ceasefire holds', 'ceasefire collapsed', a, b)).toBe('temporal')
  })

  it('categorize: same-day or undatable → factual', () => {
    const a = { id: 'ENG-2026-0407-001' } as unknown as Engram
    const b = { id: 'ENG-2026-0407-002' } as unknown as Engram
    expect(categorizeTension('cli is v1', 'cli is v2', a, b)).toBe('factual')
    expect(categorizeTension('cli is v1', 'cli is v2')).toBe('factual')
  })
})

describe('scan suppression via recorded pairs (#181)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-tension-sup-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('recorded pairs are excluded from future scans (no LLM call)', async () => {
    const a = plur.learn('plur cli version is 0.3.0')
    const b = plur.learn('plur cli version is 0.8.2')
    plur.recordTensions([pairOf(a, b)])

    const llm = vi.fn(async () => 'CONTRADICTS: yes\nCONFIDENCE: 1.0\nREASON: versions differ.')
    const result = await scanForTensions(plur.list(), llm, {
      exclude_pairs: new Set(plur.suppressedTensionPairKeys()),
    })
    expect(result.pairs_checked).toBe(0)
    expect(llm).not.toHaveBeenCalled()
  })

  it('dismissed pairs stay suppressed', async () => {
    const a = plur.learn('plur cli version is 0.3.0')
    const b = plur.learn('plur cli version is 0.8.2')
    const { records } = plur.recordTensions([pairOf(a, b)])
    plur.dismissTension(records[0].id)

    expect(plur.suppressedTensionPairKeys()).toContain(tensionPairKey(a.id, b.id))
  })

  it('relations.conflicts no longer exempts a pair from judging (audit C1)', () => {
    // Importer-written conflict suspects must reach the LLM judge.
    const mk = (id: string, statement: string, conflicts: string[] = []): Engram => ({
      id, statement,
      version: 2, status: 'active', consolidated: false, type: 'behavioral',
      scope: 'global', visibility: 'private',
      activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-07-01' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
      knowledge_anchors: [], associations: [], derivation_count: 1, tags: [],
      content_hash: id, commitment: 'leaning', engram_version: 1, episode_ids: [], polarity: null,
      ...(conflicts.length > 0 ? { relations: { broader: [], narrower: [], related: [], conflicts } } : {}),
    } as unknown as Engram)

    const a = mk('E1', 'plur search uses BM25.', ['E2'])
    const b = mk('E2', 'plur search uses embeddings.')
    expect(getCandidatePairs([a, b])).toHaveLength(1)

    // …but a recorded pair IS excluded:
    expect(getCandidatePairs([a, b], { exclude_pairs: new Set([tensionPairKey('E1', 'E2')]) })).toHaveLength(0)
  })
})

describe('confirm / dismiss / resolve (#181)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-tension-res-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function seed(): { id: string; a: Engram; b: Engram } {
    const a = plur.learn('plur cli version is 0.3.0')
    const b = plur.learn('plur cli version is 0.8.2')
    const { records } = plur.recordTensions([pairOf(a, b)])
    return { id: records[0].id, a: a as Engram, b: b as Engram }
  }

  it('confirm marks a detected tension confirmed', () => {
    const { id } = seed()
    const record = plur.confirmTension(id)
    expect(record.status).toBe('confirmed')
    expect(plur.listTensions({ status: ['confirmed'] })).toHaveLength(1)
  })

  it('dismiss works from detected and confirmed', () => {
    const { id } = seed()
    plur.confirmTension(id)
    const record = plur.dismissTension(id)
    expect(record.status).toBe('dismissed')
  })

  it('resolve picks a winner, retires the loser, stamps the record', () => {
    const { id, a, b } = seed()
    const { record, retired_id } = plur.resolveTension(id, b.id)

    expect(record.status).toBe('resolved')
    expect(record.resolved_by).toBe(b.id)
    expect(record.resolved_at).toBeTruthy()
    expect(retired_id).toBe(a.id)

    const loser = new Plur({ path: dir }).getById(a.id)
    expect(loser?.status).toBe('retired')
    expect(loser?.rationale).toContain(id)
    // Winner untouched
    expect(plur.getById(b.id)?.status).toBe('active')
  })

  it('resolve retires a multiply-learned loser outright (no reference-count games)', () => {
    const a = plur.learn('plur cli version is 0.3.0')
    plur.learn('plur cli version is 0.3.0', { scope: 'project:other' }) // bump reference_count
    const b = plur.learn('plur cli version is 0.8.2')
    const { records } = plur.recordTensions([pairOf(plur.getById(a.id)!, b)])

    plur.resolveTension(records[0].id, b.id)
    expect(plur.getById(a.id)?.status).toBe('retired')
  })

  it('resolve rejects a winner outside the pair', () => {
    const { id } = seed()
    const c = plur.learn('unrelated statement about storage')
    expect(() => plur.resolveTension(id, c.id)).toThrow(/not part of tension/)
  })

  it('terminal states are enforced', () => {
    const { id, b } = seed()
    plur.resolveTension(id, b.id)
    expect(() => plur.confirmTension(id)).toThrow(/already resolved/)
    expect(() => plur.dismissTension(id)).toThrow(/already resolved/)
    expect(() => plur.resolveTension(id, b.id)).toThrow(/already resolved/)
  })

  it('unknown tension ids throw', () => {
    expect(() => plur.confirmTension('T-0000-0000-001')).toThrow(/not found/)
  })
})

describe('injection warnings (#181, audit item 4)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-tension-inj-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('confirmed tension warns when either side injects', () => {
    // pinned → bypasses the relevance gate, so injection is deterministic
    const a = plur.learn('use tabs for indentation in this repo', { pinned: true })
    const b = plur.learn('completely unrelated fact about databases')
    const { records } = plur.recordTensions([pairOf(a, b)])
    plur.confirmTension(records[0].id)

    const result = plur.inject('anything at all')
    expect(result.injected_ids).toContain(a.id)
    expect(result.warnings).toBeDefined()
    expect(result.warnings![0]).toContain(records[0].id)
    expect(result.warnings![0]).toMatch(/contradicts/)
  })

  it('detected tension warns only when BOTH sides inject', () => {
    const a = plur.learn('use tabs for indentation in this repo', { pinned: true })
    const b = plur.learn('completely unrelated fact about databases')
    plur.recordTensions([pairOf(a, b)])

    const oneSide = plur.inject('anything at all')
    expect(oneSide.injected_ids).toContain(a.id)
    expect(oneSide.warnings).toBeUndefined()

    // Pin the other side too — now both inject and the warning fires
    const bStored = plur.getById(b.id)!
    plur.updateEngram({ ...bStored, pinned: true } as Engram)
    const bothSides = plur.inject('anything at all')
    expect(bothSides.injected_ids).toEqual(expect.arrayContaining([a.id, b.id]))
    expect(bothSides.warnings).toBeDefined()
    expect(bothSides.warnings![0]).toMatch(/Tension T-/)
  })

  it('resolved and dismissed tensions never warn', () => {
    const a = plur.learn('use tabs for indentation in this repo', { pinned: true })
    const b = plur.learn('use spaces for indentation in this repo', { pinned: true })
    const { records } = plur.recordTensions([pairOf(a, b)])
    plur.dismissTension(records[0].id)

    const result = plur.inject('anything at all')
    expect(result.warnings).toBeUndefined()
  })
})

describe('lock-escalation gate (#181, audit item 3)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-tension-lock-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const STMT = 'deploy platform is fly.io for all services'

  /** Drive cross-scope recurrence to the point where the NEXT hit would lock. */
  function escalateToDecided(): Engram {
    plur.learn(STMT, { scope: 'project:a' })            // create (leaning)
    plur.learn(STMT, { scope: 'project:b' })            // recurrence 1 — no escalation
    const e = plur.learn(STMT, { scope: 'project:c' })  // recurrence 2 — leaning → decided
    expect((plur.getById(e.id) as any).commitment).toBe('decided')
    return e as Engram
  }

  it('without a tension, the next cross-scope hit locks (baseline #176 behavior)', () => {
    const e = escalateToDecided()
    plur.learn(STMT, { scope: 'project:d' })            // recurrence 3 — decided → locked
    expect((plur.getById(e.id) as any).commitment).toBe('locked')
  })

  it('an unresolved tension blocks the decided → locked step', () => {
    const e = escalateToDecided()
    const rival = plur.learn('deploy platform is render.com for all services')
    plur.recordTensions([pairOf(plur.getById(e.id)!, rival)])

    plur.learn(STMT, { scope: 'project:d' })            // recurrence 3 — capped
    expect((plur.getById(e.id) as any).commitment).toBe('decided')
  })

  it('resolving the tension re-opens the path to locked', () => {
    const e = escalateToDecided()
    const rival = plur.learn('deploy platform is render.com for all services')
    const { records } = plur.recordTensions([pairOf(plur.getById(e.id)!, rival)])

    plur.learn(STMT, { scope: 'project:d' })            // blocked
    expect((plur.getById(e.id) as any).commitment).toBe('decided')

    plur.resolveTension(records[0].id, e.id)            // engram wins
    plur.learn(STMT, { scope: 'project:e' })            // next hit locks
    expect((plur.getById(e.id) as any).commitment).toBe('locked')
  })
})
