import { describe, it, expect } from 'vitest'
import { scanForInversions } from '../src/inversion-scan.js'

/**
 * E2 (2026-09 audit follow-up): a read-only heuristic scan for engrams the
 * pre-fix negation-inversion bug (learner.ts CORRECTION_PATTERNS /
 * PREFERENCE_PATTERNS, E1) already wrote before it was fixed. These tests
 * pin the detector's shape, not any promise of completeness — see the
 * module docstring's HEURISTIC caveat.
 */
describe('scanForInversions', () => {
  it('flags the exact fragments the pre-fix CORRECTION_PATTERNS[1] produced', () => {
    const suspects = scanForInversions([
      { id: 'ENG-1', statement: 'You should' },
      { id: 'ENG-2', statement: 'Deploying straight to production is' },
      { id: 'ENG-3', statement: 'The staging database is' },
    ])
    expect(suspects.map(s => s.id)).toEqual(['ENG-1', 'ENG-2', 'ENG-3'])
    for (const s of suspects) {
      expect(s.shapes).toContain('truncated-tail')
      expect(s.reason.length).toBeGreaterThan(0)
    }
  })

  it('flags a bare action clause with no leading directive word', () => {
    const suspects = scanForInversions([
      { id: 'ENG-1', statement: 'commit the API key to the repo' },
      { id: 'ENG-2', statement: 'use pnpm for installs' },
    ])
    expect(suspects.map(s => s.id)).toEqual(['ENG-1', 'ENG-2'])
    for (const s of suspects) expect(s.shapes).toContain('bare-imperative')
  })

  it('does not flag a correctly-extracted (post-fix) negation', () => {
    const suspects = scanForInversions([
      { id: 'ENG-1', statement: 'never commit the API key to the repo' },
      { id: 'ENG-2', statement: "don't push directly to main" },
      { id: 'ENG-3', statement: 'do not delete the production database' },
      { id: 'ENG-4', statement: 'You must not deploy on Friday' },
      { id: 'ENG-5', statement: 'You should not commit the API key to the repo' },
    ])
    expect(suspects).toHaveLength(0)
  })

  it('does not flag an ordinary complete statement', () => {
    const suspects = scanForInversions([
      { id: 'ENG-1', statement: 'The deploy script needs sudo access on the staging host' },
      { id: 'ENG-2', statement: 'PLUR stores engrams as plain YAML, never SQLite as primary storage' },
    ])
    expect(suspects).toHaveLength(0)
  })

  it('catches both shapes on one statement as a stronger combined signal', () => {
    const suspects = scanForInversions([{ id: 'ENG-1', statement: 'commit the key to' }])
    expect(suspects[0].shapes).toEqual(expect.arrayContaining(['truncated-tail', 'bare-imperative']))
  })

  it('skips empty and very short statements rather than flagging noise', () => {
    expect(scanForInversions([{ id: 'ENG-1', statement: '' }])).toHaveLength(0)
    expect(scanForInversions([{ id: 'ENG-2', statement: 'is' }])).toHaveLength(0)
  })

  it('is read-only: never mutates the input array or its entries', () => {
    const input = [{ id: 'ENG-1', statement: 'The staging database is' }]
    const snapshot = JSON.parse(JSON.stringify(input))
    scanForInversions(input)
    expect(input).toEqual(snapshot)
  })
})
