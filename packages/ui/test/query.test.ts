import { describe, expect, it } from 'vitest'
import { createdOn, filterEngrams, memoryStats, recallCount, topByRecall, writtenPerDay, type EngramRow } from '../src/query.js'

const row = (over: Partial<EngramRow> = {}): EngramRow => ({
  id: 'ENG-1',
  statement: 'Pin dsh deps to one release line.',
  scope: 'project:acme',
  status: 'active',
  injection_count: 0,
  activation: { frequency: 0 },
  temporal: { learned_at: '2026-08-10' },
  ...over,
})

describe('recallCount — the field that is actually populated', () => {
  it('reads activation.frequency, the retrieval counter with real history', () => {
    expect(recallCount(row({ activation: { frequency: 594 } }))).toBe(594)
  })

  it('prefers frequency over injection_count', () => {
    // injection_count shipped 2026-08-13. Using it as the headline reported a
    // store with 8 months of use as 99% never recalled, which is simply false.
    expect(recallCount(row({ activation: { frequency: 40 }, injection_count: 1 }))).toBe(40)
  })

  it('falls back to injection_count when there is no frequency', () => {
    expect(recallCount(row({ activation: undefined, injection_count: 3 }))).toBe(3)
  })

  it('is 0 when neither is set', () => {
    expect(recallCount(row({ activation: undefined, injection_count: undefined }))).toBe(0)
    expect(recallCount(null)).toBe(0)
  })
})

describe('createdOn — the date source that actually exists', () => {
  it('parses the compact id form', () => {
    expect(createdOn(row({ id: 'ENG-2026-0814-017' }))).toBe('2026-08-14')
  })

  it('parses the dashed id form', () => {
    expect(createdOn(row({ id: 'ENG-2026-08-03-005' }))).toBe('2026-08-03')
  })

  it('parses an org-prefixed id', () => {
    expect(createdOn(row({ id: 'ENG-GPL-2026-0729-046' }))).toBe('2026-07-29')
  })

  it('falls back to temporal.learned_at for a non-conforming id', () => {
    expect(createdOn(row({ id: 'custom-id', temporal: { learned_at: '2026-05-01' } }))).toBe('2026-05-01')
  })

  it('is undefined when neither source yields a date', () => {
    expect(createdOn(row({ id: 'custom-id', temporal: undefined }))).toBeUndefined()
  })
})

describe('filterEngrams', () => {
  it('returns everything when no filters are given', () => {
    const rows = [row({ id: 'A' }), row({ id: 'B' })]
    expect(filterEngrams(rows, {}).total).toBe(2)
  })

  it('searches the statement, case-insensitively', () => {
    const rows = [row({ id: 'A', statement: 'Deploy with pnpm.' }), row({ id: 'B', statement: 'Unrelated.' })]
    expect(filterEngrams(rows, { q: 'PNPM' }).rows.map(r => r.id)).toEqual(['A'])
  })

  it('searches the id too, so pasting an ID finds it', () => {
    const rows = [row({ id: 'ENG-2026-0814-017' }), row({ id: 'ENG-OTHER' })]
    expect(filterEngrams(rows, { q: '0814' }).rows.map(r => r.id)).toEqual(['ENG-2026-0814-017'])
  })

  it('filters by scope exactly, not by prefix', () => {
    const rows = [row({ id: 'A', scope: 'project:acme' }), row({ id: 'B', scope: 'project:acme-two' })]
    expect(filterEngrams(rows, { scope: 'project:acme' }).rows.map(r => r.id)).toEqual(['A'])
  })

  it('filters by status', () => {
    const rows = [row({ id: 'A', status: 'active' }), row({ id: 'B', status: 'retired' })]
    expect(filterEngrams(rows, { status: 'retired' }).rows.map(r => r.id)).toEqual(['B'])
  })

  it('reports the pre-pagination total alongside the page', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: `E${i}` }))
    const page = filterEngrams(rows, { limit: 3, offset: 6 })
    expect(page.rows).toHaveLength(3)
    expect(page.total).toBe(10)
  })

  it('clamps an offset past the end to an empty page, not a crash', () => {
    expect(filterEngrams([row()], { offset: 999 }).rows).toEqual([])
  })

  it('sorts newest first, by the date in the id', () => {
    const rows = [row({ id: 'ENG-2026-0101-001' }), row({ id: 'ENG-2026-0814-001' })]
    expect(filterEngrams(rows, {}).rows.map(r => r.id)).toEqual(['ENG-2026-0814-001', 'ENG-2026-0101-001'])
  })

  it('tolerates rows with missing fields rather than throwing', () => {
    const junk = [{}, { id: 'X' }, null] as unknown as EngramRow[]
    expect(() => filterEngrams(junk, { q: 'anything' })).not.toThrow()
  })
})

describe('memoryStats', () => {
  it('counts total, recalled and never-recalled', () => {
    const rows = [row({ activation: { frequency: 5 } }), row({ activation: { frequency: 0 } }), row({ activation: { frequency: 2 } })]
    expect(memoryStats(rows)).toMatchObject({ total: 3, recalled: 2, neverRecalled: 1 })
  })

  it('surfaces the never-recalled share — the "nobody is using this" signal', () => {
    const rows = [row({ activation: { frequency: 0 } }), row({ activation: { frequency: 0 } }), row({ activation: { frequency: 0 } }), row({ activation: { frequency: 1 } })]
    expect(memoryStats(rows).neverRecalledPct).toBe(75)
  })

  it('never claims 100% never-recalled while some HAVE been recalled', () => {
    // 5409/5429 rounds to 100, which printed beside "20 recalled" reads as a bug.
    const rows = [...Array.from({ length: 5409 }, () => row({ activation: { frequency: 0 } })),
                  ...Array.from({ length: 20 }, () => row({ activation: { frequency: 1 } }))]
    expect(memoryStats(rows).neverRecalledPct).toBe(99)
  })

  it('never claims 0% while some have NOT been recalled', () => {
    const rows = [...Array.from({ length: 999 }, () => row({ activation: { frequency: 5 } })), row({ activation: { frequency: 0 } })]
    expect(memoryStats(rows).neverRecalledPct).toBe(1)
  })

  it('reports a true 100% when nothing has ever been recalled', () => {
    expect(memoryStats([row({ activation: { frequency: 0 } })]).neverRecalledPct).toBe(100)
  })

  it('does not divide by zero on an empty store', () => {
    expect(memoryStats([])).toMatchObject({ total: 0, recalled: 0, neverRecalled: 0, neverRecalledPct: 0 })
  })

  it('counts distinct scopes', () => {
    const rows = [row({ scope: 'a' }), row({ scope: 'b' }), row({ scope: 'a' })]
    expect(memoryStats(rows).scopes).toBe(2)
  })
})

describe('topByRecall', () => {
  it('ranks by injection count, descending', () => {
    const rows = [row({ id: 'A', injection_count: 1 }), row({ id: 'B', injection_count: 9 }), row({ id: 'C', injection_count: 4 })]
    expect(topByRecall(rows, 3).map(r => r.id)).toEqual(['B', 'C', 'A'])
  })

  it('omits never-recalled engrams — a top list of zeroes says nothing', () => {
    const rows = [row({ id: 'A', injection_count: 0 }), row({ id: 'B', injection_count: 3 })]
    expect(topByRecall(rows, 5).map(r => r.id)).toEqual(['B'])
  })

  it('respects the limit', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: `E${i}`, injection_count: i + 1 }))
    expect(topByRecall(rows, 5)).toHaveLength(5)
  })
})

describe('writtenPerDay', () => {
  it('buckets by the engram id date', () => {
    const rows = [
      row({ id: 'ENG-2026-0814-001' }),
      row({ id: 'ENG-2026-0814-002' }),
      row({ id: 'ENG-2026-0813-001' }),
    ]
    const days = writtenPerDay(rows, 3, new Date('2026-08-14T12:00:00Z'))
    expect(days.at(-1)).toEqual({ date: '2026-08-14', count: 2 })
    expect(days.at(-2)).toEqual({ date: '2026-08-13', count: 1 })
  })

  it('emits a contiguous run of days including empty ones', () => {
    const days = writtenPerDay([], 7, new Date('2026-08-14T12:00:00Z'))
    expect(days).toHaveLength(7)
    expect(days.every(d => d.count === 0)).toBe(true)
    expect(days.at(-1)!.date).toBe('2026-08-14')
  })

  it('ignores engrams older than the window', () => {
    const rows = [row({ id: 'ENG-2020-0101-001', temporal: { learned_at: '2020-01-01' } })]
    const days = writtenPerDay(rows, 5, new Date('2026-08-14T12:00:00Z'))
    expect(days.reduce((s, d) => s + d.count, 0)).toBe(0)
  })

  it('tolerates a missing or malformed date', () => {
    const rows = [row({ id: 'x', temporal: undefined }), row({ id: 'y', temporal: { learned_at: 'not-a-date' } })]
    expect(() => writtenPerDay(rows, 5, new Date('2026-08-14T12:00:00Z'))).not.toThrow()
  })

  it('accepts a full ISO timestamp in the learned_at fallback', () => {
    const rows = [row({ id: 'no-date-here', temporal: { learned_at: '2026-08-14T09:31:00.000Z' } })]
    const days = writtenPerDay(rows, 2, new Date('2026-08-14T12:00:00Z'))
    expect(days.at(-1)).toEqual({ date: '2026-08-14', count: 1 })
  })
})
