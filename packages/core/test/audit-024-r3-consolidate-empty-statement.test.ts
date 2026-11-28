/**
 * 0.24 review, round 3: a model answer with an empty STATEMENT line is not a
 * merge. The statement is read from the STATEMENT line itself; the next line
 * (REASON, or anything else) is never taken as the merged statement.
 */
import { describe, it, expect } from 'vitest'
import { parseConsolidationResponse } from '../src/consolidate.js'

describe('round 3: an empty STATEMENT line is not a merge', () => {
  it('STATEMENT: followed by a newline and REASON is pending, not a merge into the reason', () => {
    const reply = 'CLUSTER_1:\nDECISION: MERGE\nSTATEMENT:\nREASON: these say the same thing\n'
    expect(parseConsolidationResponse(reply, 1)).toEqual([{ decision: 'pending' }])
  })

  it('a STATEMENT on its own line still merges', () => {
    const reply = 'CLUSTER_1:\nDECISION: MERGE\nSTATEMENT: Use tabs for indentation\nREASON: same rule\n'
    expect(parseConsolidationResponse(reply, 1)).toEqual([{ decision: 'merge', statement: 'Use tabs for indentation', reason: 'same rule' }])
  })
})
