/**
 * Hardening H3: splitting the consolidation reply must stay linear. The old
 * splitter (`^\s*\**\s*CLUSTER_…` with the m flag) backtracked over runs of
 * blank lines: 4,000 newlines took ~42 s.
 */
import { describe, it, expect } from 'vitest'
import { parseConsolidationResponse, MAX_CONSOLIDATION_REPLY_CHARS } from '../src/consolidate.js'

describe('parseConsolidationResponse is linear on hostile replies (H3)', () => {
  it('parses 4,000 newlines followed by x in well under a second', () => {
    const reply = '\n'.repeat(4000) + 'x'
    const t0 = performance.now()
    const out = parseConsolidationResponse(reply, 2)
    const ms = performance.now() - t0
    expect(out).toEqual([{ decision: 'pending' }, { decision: 'pending' }])
    expect(ms).toBeLessThan(500)
  }, 5_000)

  it('still parses a well-formed reply with indentation and bold markers', () => {
    const reply = '  **CLUSTER_1:**\nDECISION: MERGE\nSTATEMENT: use pnpm\nREASON: same\n\nCLUSTER_2:\nDECISION: SPLIT\nSTATEMENT: none\nREASON: differ'
    expect(parseConsolidationResponse(reply, 2)).toEqual([
      { decision: 'merge', statement: 'use pnpm', reason: 'same' },
      { decision: 'split', reason: 'differ' },
    ])
  })

  it('caps the reply length before parsing; clusters past the cap are pending', () => {
    const filler = 'y'.repeat(MAX_CONSOLIDATION_REPLY_CHARS)
    const reply = 'CLUSTER_1:\nDECISION: SPLIT\nSTATEMENT: none\nREASON: r\n' + filler + '\nCLUSTER_2:\nDECISION: SPLIT\nREASON: r'
    const out = parseConsolidationResponse(reply, 2)
    expect(out[0]).toEqual({ decision: 'split', reason: 'r' })
    expect(out[1]).toEqual({ decision: 'pending' })
  })
})
