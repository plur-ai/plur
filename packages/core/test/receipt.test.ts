import { describe, it, expect } from 'vitest'
import { computeReceipt } from '../src/receipt.js'
import type { CoInjectionEvent } from '../src/history.js'

const NOW = new Date('2026-07-21T12:00:00.000Z')

function ev(
  ts: string, ids: string[], session_id?: string,
  source: 'hook' | 'inject' | 'session_start' = 'hook',
  tokens_used = 100,
): CoInjectionEvent {
  return {
    injection_id: `INJ-${ts}-${ids.join('')}`,
    timestamp: ts,
    data: { ids, query_hash: '0123456789abcdef', session_id, source, tokens_used },
  }
}

describe('computeReceipt — stored counts', () => {
  it('reports zero state with no events', () => {
    const r = computeReceipt({ ownEngramIds: ['E1', 'E2'], packEngramIds: [], events: [], now: NOW })
    expect(r.stored.total).toBe(2)
    expect(r.retrieved.engrams).toBe(0)
    expect(r.retrieved.retrievals).toBe(0)
    expect(r.coverage.source).toBe('none')
    expect(r.dormant.never_retrieved).toBe(2)
    expect(r.retrieved.activation_rate).toBe(0)
  })

  it('splits stored engrams into own and pack that sum to total', () => {
    const r = computeReceipt({
      ownEngramIds: ['E1', 'E2', 'E3'], packEngramIds: ['P1'], events: [], now: NOW,
    })
    expect(r.stored).toEqual({ own: 3, pack: 1, total: 4 })
    expect(r.stored.own + r.stored.pack).toBe(r.stored.total)
  })

  it('keeps own + pack === total when an id is in both (own wins)', () => {
    const r = computeReceipt({
      ownEngramIds: ['E1'], packEngramIds: ['E1', 'P1'], events: [], now: NOW,
    })
    expect(r.stored).toEqual({ own: 1, pack: 1, total: 2 })
    expect(r.stored.own + r.stored.pack).toBe(r.stored.total)
  })
})

describe('computeReceipt — retrieval counts', () => {
  it('counts retrievals, distinct engrams and activation rate', () => {
    const events = [
      ev('2026-07-20T10:00:00.000Z', ['E1', 'E2'], 's1'),
      ev('2026-07-20T11:00:00.000Z', ['E1'], 's1'),
    ]
    const r = computeReceipt({ ownEngramIds: ['E1', 'E2', 'E3', 'E4'], packEngramIds: [], events, now: NOW })
    expect(r.retrieved.retrievals).toBe(2)
    expect(r.retrieved.engrams).toBe(2)
    expect(r.retrieved.activation_rate).toBeCloseTo(0.5)
    expect(r.dormant.never_retrieved).toBe(2)
  })

  it('counts distinct (engram, session) pairs, not raw appearances', () => {
    const events = [
      ev('2026-07-20T10:00:00.000Z', ['E1'], 's1'),
      ev('2026-07-20T11:00:00.000Z', ['E1'], 's1'), // same session — one pair
      ev('2026-07-20T12:00:00.000Z', ['E1'], 's2'), // new session — second pair
    ]
    const r = computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW })
    expect(r.retrieved.engram_session_pairs).toBe(2)
    expect(r.retrieved.retrievals).toBe(3)
    expect(r.window.sessions).toBe(2)
  })

  it('a retired engram does not inflate activation rate', () => {
    const events = [ev('2026-07-20T10:00:00.000Z', ['GONE'], 's1')]
    const r = computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW })
    expect(r.dormant.unavailable_but_retrieved).toBe(1)
    expect(r.retrieved.engrams).toBe(0)
    expect(r.retrieved.activation_rate).toBe(0)
  })
})

describe('computeReceipt — reuse', () => {
  it('computes median, mean and max over one consistent population', () => {
    const events = [
      ev('2026-07-20T10:00:00.000Z', ['A', 'B', 'C'], 's1'),
      ev('2026-07-20T11:00:00.000Z', ['A', 'B'], 's2'),
      ev('2026-07-20T12:00:00.000Z', ['A'], 's3'),
    ]
    const r = computeReceipt({ ownEngramIds: ['A', 'B', 'C'], packEngramIds: [], events, now: NOW })
    expect(r.reuse.max).toBe(3)
    expect(r.reuse.median).toBe(2)
    expect(r.reuse.mean).toBeCloseTo(2)
    expect(r.reuse.top[0]).toEqual({ id: 'A', count: 3, retired: false })
  })

  it('reuse.max never contradicts a larger entry in reuse.top (both live-only)', () => {
    // GONE is retrieved 5x but retired; E1 is stored and retrieved once.
    const events = [
      ev('2026-07-20T10:00:00.000Z', ['GONE'], 's1'),
      ev('2026-07-20T11:00:00.000Z', ['GONE'], 's2'),
      ev('2026-07-20T12:00:00.000Z', ['GONE'], 's3'),
      ev('2026-07-20T13:00:00.000Z', ['GONE'], 's4'),
      ev('2026-07-20T14:00:00.000Z', ['GONE'], 's5'),
      ev('2026-07-20T15:00:00.000Z', ['E1'], 's6'),
    ]
    const r = computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW })
    // reuse block is stored-only, so max is E1's 1 — and every top entry the
    // reuse block could describe is <= max. Retired engrams live in their own list.
    expect(r.reuse.max).toBe(1)
    for (const t of r.reuse.top.filter(e => !e.retired)) {
      expect(t.count).toBeLessThanOrEqual(r.reuse.max)
    }
    expect(r.reuse.top.find(e => e.id === 'GONE')?.retired).toBe(true)
  })

  it('sorts top deterministically without locale dependence', () => {
    const events = [
      ev('2026-07-20T10:00:00.000Z', ['B', 'A'], 's1'),
      ev('2026-07-20T11:00:00.000Z', ['B', 'A'], 's2'),
    ]
    const r = computeReceipt({ ownEngramIds: ['A', 'B'], packEngramIds: [], events, now: NOW })
    // A and B tie at 2; tie broken by id ascending → A first.
    expect(r.reuse.top.map(t => t.id)).toEqual(['A', 'B'])
  })
})

describe('computeReceipt — windowing', () => {
  it('filters retrievals to the requested window', () => {
    const events = [
      ev('2026-05-01T10:00:00.000Z', ['OLD'], 's-old'),
      ev('2026-07-20T10:00:00.000Z', ['NEW'], 's-new'),
    ]
    const r = computeReceipt({
      ownEngramIds: ['OLD', 'NEW'], packEngramIds: [], events, now: NOW, days: 7,
    })
    expect(r.retrieved.retrievals).toBe(1)
    expect(r.retrieved.engrams).toBe(1)
    expect(r.window.sessions).toBe(1)
  })

  it('window.days reflects the requested lookback, not the event span', () => {
    const events = [ev('2026-07-20T10:00:00.000Z', ['E1'], 's1')]
    const r = computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW, days: 30 })
    expect(r.window.requested_days).toBe(30)
  })

  it('activation_rate and dormant are windowed consistently and flagged', () => {
    // 400 stored, only 1 retrieved last month, window = 1 day → nothing in window.
    const stored = Array.from({ length: 400 }, (_, i) => `E${i}`)
    const events = [ev('2026-06-20T10:00:00.000Z', ['E0'], 's1')]
    const r = computeReceipt({ ownEngramIds: stored, packEngramIds: [], events, now: NOW, days: 1 })
    expect(r.retrieved.retrievals).toBe(0)
    expect(r.retrieved.activation_rate).toBe(0)
    // dormant is "not retrieved in window", and the receipt says so via windowed flag
    expect(r.window.windowed).toBe(true)
  })

  it('windowed is false for an all-time receipt', () => {
    const r = computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events: [], now: NOW })
    expect(r.window.windowed).toBe(false)
  })
})

describe('computeReceipt — clock skew and bad input', () => {
  it('drops events timestamped in the future rather than stretching the window', () => {
    const events = [
      ev('2026-07-20T10:00:00.000Z', ['E1'], 's1'),
      ev('2099-01-01T00:00:00.000Z', ['E1'], 's2'),
    ]
    const r = computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW })
    expect(r.retrieved.retrievals).toBe(1)
    expect(r.window.to).toBe('2026-07-20')
    expect(r.skipped_future).toBe(1)
  })

  it('treats days: 0 and NaN as all-time rather than empty', () => {
    const events = [ev('2026-07-20T10:00:00.000Z', ['E1'], 's1')]
    expect(computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW, days: 0 }).retrieved.retrievals).toBe(1)
    expect(computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW, days: NaN }).retrieved.retrievals).toBe(1)
  })
})

describe('computeReceipt — sessions and coverage', () => {
  it('treats events with no session_id as distinct anonymous sessions', () => {
    const events = [
      ev('2026-07-20T10:00:00.000Z', ['E1'], undefined),
      ev('2026-07-20T11:00:00.000Z', ['E1'], undefined),
    ]
    const r = computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW })
    expect(r.retrieved.engram_session_pairs).toBe(2)
    expect(r.coverage.session_id_coverage).toBe(0)
  })

  it('reports session_id coverage as a fraction', () => {
    const events = [
      ev('2026-07-20T10:00:00.000Z', ['E1'], 's1'),
      ev('2026-07-20T11:00:00.000Z', ['E1'], undefined),
    ]
    const r = computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW })
    expect(r.coverage.session_id_coverage).toBeCloseTo(0.5)
  })

  it('sets coverage.complete_from to the earliest all-time event, not the windowed one', () => {
    const events = [
      ev('2026-07-03T09:00:00.000Z', ['E1'], 's1'),
      ev('2026-07-20T09:00:00.000Z', ['E2'], 's2'),
    ]
    const r = computeReceipt({ ownEngramIds: ['E1', 'E2'], packEngramIds: [], events, now: NOW, days: 7 })
    // Only E2 is in the 7-day window, but the earliest LOGGED retrieval is 07-03.
    expect(r.coverage.complete_from).toBe('2026-07-03')
    expect(r.coverage.source).toBe('co_injection')
  })
})

describe('computeReceipt — sources', () => {
  it('breaks retrievals down by source', () => {
    const events = [
      ev('2026-07-20T10:00:00.000Z', ['E1'], 's1', 'hook'),
      ev('2026-07-20T11:00:00.000Z', ['E1'], 's2', 'hook'),
      ev('2026-07-20T12:00:00.000Z', ['E1'], 's3', 'session_start'),
    ]
    const r = computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW })
    expect(r.sources).toEqual({ hook: 2, session_start: 1 })
  })

  it('buckets events with no source under unknown', () => {
    const legacy: CoInjectionEvent = {
      injection_id: 'INJ-legacy', timestamp: '2026-07-20T10:00:00.000Z',
      data: { ids: ['E1'], query_hash: '0123456789abcdef' },
    }
    const r = computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events: [legacy], now: NOW })
    expect(r.sources).toEqual({ unknown: 1 })
  })
})

describe('computeReceipt — external (team-store) retrievals', () => {
  it('classifies a retrieved team-store id as external, not retired', () => {
    const events = [
      ev('2026-07-20T10:00:00.000Z', ['ENG-DF-2026-0101-001'], 's1'),
      ev('2026-07-20T11:00:00.000Z', ['E1'], 's2'),
    ]
    const r = computeReceipt({
      ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW,
      externalIdPrefixes: ['ENG-DF-'],
    })
    expect(r.external_retrieved).toBe(1)
    expect(r.dormant.unavailable_but_retrieved).toBe(0)
  })

  it('keeps a truly-gone (local, unprefixed) id as retired', () => {
    const events = [ev('2026-07-20T10:00:00.000Z', ['ENG-2026-0101-999'], 's1')]
    const r = computeReceipt({
      ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW,
      externalIdPrefixes: ['ENG-DF-'],
    })
    expect(r.external_retrieved).toBe(0)
    expect(r.dormant.unavailable_but_retrieved).toBe(1)
  })

  it('excludes external ids from the most-reused list', () => {
    const events = [
      ev('2026-07-20T10:00:00.000Z', ['ENG-DF-2026-0101-001'], 's1'),
      ev('2026-07-20T11:00:00.000Z', ['ENG-DF-2026-0101-001'], 's2'),
      ev('2026-07-20T12:00:00.000Z', ['E1'], 's3'),
    ]
    const r = computeReceipt({
      ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW,
      externalIdPrefixes: ['ENG-DF-'],
    })
    expect(r.reuse.top.map(t => t.id)).toEqual(['E1'])
  })
})

describe('computeReceipt — publishing guarantees', () => {
  it('the numeric shape never carries a cost, dollar or savings field', () => {
    const events = [ev('2026-07-20T10:00:00.000Z', ['E1'], 's1')]
    const r = computeReceipt({ ownEngramIds: ['E1'], packEngramIds: [], events, now: NOW })
    // Assert on the KEY names, not the serialized values — engram ids like
    // 'ENG-neural-notes' contain 'eur' and would make a value-scan flaky.
    const keys: string[] = []
    const walk = (o: unknown) => {
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o)) { keys.push(k.toLowerCase()); walk(v) }
      } else if (Array.isArray(o)) o.forEach(walk)
    }
    walk(r)
    for (const banned of ['saving', 'cost', 'usd', 'eur', 'dollar', 'price', 'token']) {
      expect(keys.some(k => k.includes(banned)), `key contains ${banned}`).toBe(false)
    }
  })

  it('does not throw on an id that itself contains banned substrings', () => {
    const events = [ev('2026-07-20T10:00:00.000Z', ['ENG-eur-cost-usd-notes'], 's1')]
    const r = computeReceipt({ ownEngramIds: ['ENG-eur-cost-usd-notes'], packEngramIds: [], events, now: NOW })
    expect(r.reuse.top[0].id).toBe('ENG-eur-cost-usd-notes')
  })
})
