import { describe, it, expect } from 'vitest'
import { selectAndSpread } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

describe('supersedes chain — inject scoring (#481)', () => {
  const makeEngram = (overrides: Partial<any> = {}) => EngramSchema.parse({
    id: 'ENG-2026-0101-001',
    statement: 'deploy using blue-green strategy',
    type: 'behavioral',
    scope: 'global',
    status: 'active',
    ...overrides,
  })

  // Both tests below list the superseded `older` FIRST in the input. Because the
  // sort is stable and both engrams score equally on the query, the ONLY thing
  // that can move `tip` ahead of `older` is the ×0.3 demotion penalty
  // (inject.ts:460-467). The previous versions listed `tip` first and/or used a
  // 5000-token budget where both fit, so stable-sort/order carried the assertion
  // and deleting the penalty left them green. Here the penalty is load-bearing.
  const makePair = () => {
    const tip = makeEngram({
      id: 'ENG-2026-0101-002',
      statement: 'deploy using canary strategy version 2',
      relations: {
        broader: [], narrower: [], related: [], conflicts: [],
        supersedes: ['ENG-2026-0101-001'],
        superseded_by: [],
      },
    })
    const older = makeEngram({
      id: 'ENG-2026-0101-001',
      statement: 'deploy using canary strategy version 1',
      relations: {
        broader: [], narrower: [], related: [], conflicts: [],
        supersedes: [],
        superseded_by: ['ENG-2026-0101-002'],
      },
    })
    return { tip, older }
  }

  const idsOf = (result: ReturnType<typeof selectAndSpread>) => [
    ...result.directives.map(e => e.id),
    ...result.constraints.map(e => e.id),
    ...result.consider.map(e => e.id),
  ]

  it('under budget pressure without historical keywords, the penalty drops the superseded engram (older-first)', () => {
    const { tip, older } = makePair()

    // Tight budget admits exactly one engram. Input order [older, tip]: without
    // the demotion penalty a stable sort keeps `older` first and it would win.
    const result = selectAndSpread(
      { prompt: 'deploy canary strategy', maxTokens: 80 },
      [older, tip], []
    )

    const ids = idsOf(result)
    // The penalty re-ranks `tip` above `older`, so `tip` survives and the
    // superseded `older` is dropped. This assertion fails if the penalty block
    // is removed.
    expect(ids).toContain(tip.id)
    expect(ids).not.toContain(older.id)
  })

  it('with a historical keyword the penalty is suppressed, so the superseded engram is retained (older-first)', () => {
    const { tip, older } = makePair()

    // Same tight one-engram budget and same [older, tip] order. "previously" is
    // a clean historical keyword (no substring collision, cf. #481) that
    // suppresses the penalty, so the stable sort keeps `older` first and it
    // survives while `tip` is dropped — the inverse of the test above.
    const result = selectAndSpread(
      { prompt: 'deploy canary strategy previously', maxTokens: 80 },
      [older, tip], []
    )

    const ids = idsOf(result)
    expect(ids).toContain(older.id)
    expect(ids).not.toContain(tip.id)
  })

  it('engram with empty superseded_by is treated as tip — no penalty', () => {
    const tip = makeEngram({
      id: 'ENG-2026-0101-003',
      statement: 'deploy using canary strategy current',
      relations: {
        broader: [], narrower: [], related: [], conflicts: [],
        supersedes: [],
        superseded_by: [],
      },
    })

    const result = selectAndSpread(
      { prompt: 'deploy canary strategy', maxTokens: 5000 },
      [tip], []
    )

    const ids = [
      ...result.directives.map(e => e.id),
      ...result.constraints.map(e => e.id),
      ...result.consider.map(e => e.id),
    ]
    expect(ids).toContain(tip.id)
  })

  // --- Word-boundary matching for historical intent (#481) ---
  // hasHistoricalIntent used SUBSTRING matching, so common words false-positived
  // as "historical" and suppressed the ×0.3 penalty, injecting the STALE
  // superseded engram instead of the current tip. 'prior' ⊂ "priority",
  // 'old' ⊂ "threshold", 'was' ⊂ "wasm". These must NOT count as historical.

  it('a prompt containing "priority" (substring "prior") is NOT historical — penalty applies, tip wins (#481)', () => {
    const { tip, older } = makePair()

    // "priority" contains the substring "prior" but is not a historical keyword.
    // Pre-fix: substring match treats this as historical, suppresses the penalty,
    // and the stable [older, tip] sort keeps the STALE `older` — the bug.
    // Post-fix: word-boundary match => non-historical => penalty demotes `tip`
    // above `older`, so the current `tip` survives and `older` is dropped.
    const result = selectAndSpread(
      { prompt: 'deploy canary strategy priority', maxTokens: 80 },
      [older, tip], []
    )

    const ids = idsOf(result)
    expect(ids).toContain(tip.id)
    expect(ids).not.toContain(older.id)
  })

  it('a genuinely historical prompt ("used to") IS historical — penalty suppressed, superseded retained (#481)', () => {
    const { tip, older } = makePair()

    // Multi-word keyword "used to" still matches as a phrase under word-boundary
    // logic. Historical intent suppresses the penalty, so the stable [older, tip]
    // sort keeps `older` and it survives while `tip` is dropped.
    const result = selectAndSpread(
      { prompt: 'the canary deploy strategy we used to prefer', maxTokens: 80 },
      [older, tip], []
    )

    const ids = idsOf(result)
    expect(ids).toContain(older.id)
    expect(ids).not.toContain(tip.id)
  })

  it('"used to" split by a newline is STILL historical — inter-word gap is \\s+, not a literal space (#481)', () => {
    const { tip, older } = makePair()

    // A pasted / wrapped multi-line prompt can put a newline (or tab, or doubled
    // space) between the words of a multi-word keyword. Matching the gap as a
    // literal U+0020 was a false-negative: "used\nto" failed hasHistoricalIntent,
    // the penalty was NOT suppressed, and the stale `older` was silently dropped.
    // Post-fix the gap is \s+, so this reads as historical exactly like "used to".
    const result = selectAndSpread(
      { prompt: 'the canary deploy strategy we used\nto prefer', maxTokens: 80 },
      [older, tip], []
    )

    const ids = idsOf(result)
    expect(ids).toContain(older.id)
    expect(ids).not.toContain(tip.id)
  })
})
