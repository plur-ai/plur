/**
 * Hardening H10: the enrichment reply parser tried every `]` from the end
 * with a fresh JSON.parse of a growing slice, which is quadratic in the reply
 * length. A hostile or runaway reply must parse in bounded time.
 */
import { describe, it, expect } from 'vitest'
import { parseEnrichReply, MAX_ENRICH_REPLY_CHARS } from '../src/enrich.js'

describe('parseEnrichReply is bounded on large replies (H10)', () => {
  it('a 140 KB reply with a long array and many trailing brackets parses in well under a second', () => {
    const reply = '[' + '1,'.repeat(50_000) + '1' + ']x'.repeat(20_000)
    const t0 = performance.now()
    const out = parseEnrichReply(reply, ['ENG-1'])
    const ms = performance.now() - t0
    expect(out.size).toBe(0)
    expect(ms).toBeLessThan(500)
  }, 60_000)

  it('still finds the array when prose with brackets follows it', () => {
    const reply = 'Here: [{"id":"ENG-1","kind":"fact","task_family":"other","outcome":"none","applies_when":"always"}] (done [ok])'
    const out = parseEnrichReply(reply, ['ENG-1'])
    expect(out.get('ENG-1')?.kind).toBe('fact')
  })

  it('ignores text past the cap', () => {
    const reply = 'x'.repeat(MAX_ENRICH_REPLY_CHARS) + '[{"id":"ENG-1","kind":"fact"}]'
    expect(parseEnrichReply(reply, ['ENG-1']).size).toBe(0)
  })
})
