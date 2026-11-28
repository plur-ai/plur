/**
 * 0.24 review, round 4: the consolidation answer parser runs in linear time
 * on runs of spaces and tabs. A reply that is a long run of blanks (or one
 * that repeats a marker's padding) parses quickly and gives `pending`.
 */
import { describe, it, expect } from 'vitest'
import { parseConsolidationResponse } from '../src/consolidate.js'

const timed = (reply: string, count = 1) => {
  const t0 = performance.now()
  const out = parseConsolidationResponse(reply, count)
  return { out, ms: performance.now() - t0 }
}

describe('round 4: the consolidation parser does not backtrack on blanks', () => {
  it('200k spaces parse in well under a second, as pending', () => {
    const { out, ms } = timed(' '.repeat(200_000))
    expect(out).toEqual([{ decision: 'pending' }])
    expect(ms).toBeLessThan(1000)
  })

  it('200k spaces and tabs after a cluster and decision marker parse quickly, as pending', () => {
    const { out, ms } = timed(`CLUSTER_1:\nDECISION:${' \t'.repeat(100_000)}x`)
    expect(out).toEqual([{ decision: 'pending' }])
    expect(ms).toBeLessThan(1000)
  })

  it('a line of 200k spaces before an unfinished marker parses quickly', () => {
    const { out, ms } = timed(`${' '.repeat(200_000)}**${' '.repeat(10)}CLUSTER_1 x`)
    expect(out).toEqual([{ decision: 'pending' }])
    expect(ms).toBeLessThan(1000)
  })

  it('bold markers still parse', () => {
    const reply = '**CLUSTER_1:**\n**DECISION:** MERGE\nSTATEMENT: Use tabs for indentation\nREASON: same rule\n'
    expect(parseConsolidationResponse(reply, 1)).toEqual([{ decision: 'merge', statement: 'Use tabs for indentation', reason: 'same rule' }])
  })
})
