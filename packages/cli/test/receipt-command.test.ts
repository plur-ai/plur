import { describe, it, expect } from 'vitest'
import { renderReceipt } from '../src/commands/receipt.js'
import type { Receipt } from '@plur-ai/core'

const receipt: Receipt = {
  window: { from: '2026-07-03', to: '2026-07-20', requested_days: null, windowed: false, sessions: 59 },
  stored: { own: 3730, pack: 771, total: 4501 },
  retrieved: { engrams: 153, activation_rate: 0.034, retrievals: 68, engram_session_pairs: 449, taught_pairs: 438, pack_pairs: 11 },
  reuse: { median: 1, mean: 2.9, max: 33, top: [{ id: 'ENG-2026-0513-004', count: 33, retired: false }] },
  dormant: { never_retrieved: 4348, unavailable_but_retrieved: 0 },
  external_retrieved: 0,
  sources: { hook: 60, session_start: 8 },
  coverage: { source: 'co_injection', complete_from: '2026-07-03', session_id_coverage: 0.87 },
}

describe('renderReceipt', () => {
  it('leads with taught delivery, not activation rate', () => {
    const out = renderReceipt(receipt)
    const pairsIdx = out.indexOf('438') // taught_pairs, not the pack-inclusive 449
    const activationIdx = out.indexOf('3%')
    expect(pairsIdx).toBeGreaterThan(-1)
    expect(activationIdx).toBeGreaterThan(-1)
    expect(pairsIdx).toBeLessThan(activationIdx) // delivery appears first
  })

  it('does not claim pack memories were taught by the user', () => {
    const out = renderReceipt(receipt)
    // headline number is taught-only; pack contribution is shown separately
    const headline = out.split('\n').find(l => l.includes('you taught'))!
    expect(headline).toContain('438')
    expect(headline).not.toContain('449')
    expect(out).toMatch(/11 from installed packs/)
  })

  it('shows the coverage window so numbers are not read as lifetime', () => {
    expect(renderReceipt(receipt)).toContain('2026-07-03')
  })

  it('reports stored, retrieved and dormant counts', () => {
    const out = renderReceipt(receipt)
    expect(out).toContain('4,501')
    expect(out).toContain('153')
    expect(out).toContain('4,348')
  })

  it('shows activation rate under a STORE HEALTH heading with the not-a-fault framing', () => {
    const out = renderReceipt(receipt)
    expect(out).toContain('STORE HEALTH')
    expect(out).toMatch(/expected, not a fault/i)
    // the 3% figure lives in the health block, not as a headline success score
    expect(out.indexOf('3% of store')).toBeGreaterThan(out.indexOf('STORE HEALTH'))
  })

  it('never claims engrams were "never" retrieved on an all-time receipt', () => {
    // "never" is unverifiable — logging started at complete_from.
    const out = renderReceipt(receipt)
    expect(out).not.toMatch(/never retrieved/i)
    expect(out).toContain('not retrieved since 2026-07-03')
  })

  it('acknowledges the logging window when framing the dormant tail', () => {
    expect(renderReceipt(receipt)).toMatch(/short logging window|predates logging/i)
  })

  it('uses the word retrieved, never served', () => {
    const out = renderReceipt(receipt).toLowerCase()
    expect(out).toContain('retriev')
    expect(out).not.toContain('served')
  })

  it('never prints a currency or savings figure', () => {
    const out = renderReceipt(receipt).toLowerCase()
    for (const banned of ['$', '€', 'saved', 'saving', 'cost']) {
      expect(out).not.toContain(banned)
    }
  })

  it('warns, with the exact coverage figure, when session_id coverage is incomplete', () => {
    // Must assert on 87% specifically — matching "session" alone is vacuous
    // because the header always prints "N sessions" regardless of the warning.
    const out = renderReceipt(receipt)
    expect(out).toContain('87%')
    expect(out).toMatch(/anonymous sessions/i)
  })

  it('renders the most-reused engram id and its count', () => {
    const out = renderReceipt(receipt)
    expect(out).toContain('ENG-2026-0513-004')
    expect(out).toContain('33')
  })

  it('renders a no-data state without crashing', () => {
    const empty: Receipt = {
      window: { from: '', to: '', requested_days: null, windowed: false, sessions: 0 },
      stored: { own: 0, pack: 0, total: 0 },
      retrieved: { engrams: 0, activation_rate: 0, retrievals: 0, engram_session_pairs: 0, taught_pairs: 0, pack_pairs: 0 },
      reuse: { median: 0, mean: 0, max: 0, top: [] },
      dormant: { never_retrieved: 0, unavailable_but_retrieved: 0 },
      external_retrieved: 0,
      sources: {},
      coverage: { source: 'none', complete_from: null, session_id_coverage: 0 },
    }
    expect(renderReceipt(empty)).toMatch(/no data yet/i)
  })

  it('suppresses the reuse block when no engram was retrieved and still stored', () => {
    const noLive: Receipt = {
      ...receipt,
      retrieved: { ...receipt.retrieved, engrams: 0 },
      reuse: { median: 0, mean: 0, max: 0, top: [{ id: 'GONE', count: 5, retired: true }] },
    }
    const out = renderReceipt(noLive)
    // must not print "0x" as if it were a measured most-reused value
    expect(out).not.toMatch(/most-reused[^\n]*\n\s+0x/i)
  })

  it('mentions external team retrievals when present', () => {
    const withExternal: Receipt = { ...receipt, external_retrieved: 12 }
    expect(renderReceipt(withExternal)).toMatch(/team|external|12/i)
  })

  it('labels dormant as window-relative when a days filter is active', () => {
    const windowed: Receipt = {
      ...receipt,
      window: { ...receipt.window, requested_days: 7, windowed: true },
    }
    const out = renderReceipt(windowed)
    expect(out).toMatch(/7 days|in the last|this window/i)
  })
})
