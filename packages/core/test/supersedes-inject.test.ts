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
  // Budgets here must fit exactly ONE of the pair — the penalty is only
  // load-bearing under real pressure. Sized at 30 after #1145 made
  // estimateTokens measure the rendered form (~27 tokens for these fixtures)
  // instead of the serialised record (~100). At the old 80 both now fit and
  // the tests passed vacuously.
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

  // Budget-pressure tests assert on the DIRECTIVES bucket, not on every bucket.
  // The penalty re-ranks (score * 0.3); it never excludes. The loser therefore
  // still lands in the DIP-0019 consider pool, and asserting its absence from
  // the whole result only passed while estimateTokens serialised the record and
  // an engram cost more than the 200-token consider budget. #1145 made the
  // estimate reflect what actually renders (~27 tokens for these fixtures), so
  // that side-effect vanished — and it was never what the penalty does.
  const dirIdsOf = (result: ReturnType<typeof selectAndSpread>) =>
    result.directives.map(e => e.id)

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
      { prompt: 'deploy canary strategy', maxTokens: 40 },
      [older, tip], []
    )

    const ids = dirIdsOf(result)
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
      { prompt: 'deploy canary strategy previously', maxTokens: 40 },
      [older, tip], []
    )

    const ids = dirIdsOf(result)
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
      { prompt: 'deploy canary strategy priority', maxTokens: 40 },
      [older, tip], []
    )

    const ids = dirIdsOf(result)
    expect(ids).toContain(tip.id)
    expect(ids).not.toContain(older.id)
  })

  it('a genuinely historical prompt ("used to") IS historical — penalty suppressed, superseded retained (#481)', () => {
    const { tip, older } = makePair()

    // Multi-word keyword "used to" still matches as a phrase under word-boundary
    // logic. Historical intent suppresses the penalty, so the stable [older, tip]
    // sort keeps `older` and it survives while `tip` is dropped.
    const result = selectAndSpread(
      { prompt: 'the canary deploy strategy we used to prefer', maxTokens: 40 },
      [older, tip], []
    )

    const ids = dirIdsOf(result)
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
      { prompt: 'the canary deploy strategy we used\nto prefer', maxTokens: 40 },
      [older, tip], []
    )

    const ids = dirIdsOf(result)
    expect(ids).toContain(older.id)
    expect(ids).not.toContain(tip.id)
  })
})

// A correction replaces what it corrected. The ×0.3 penalty above only
// re-ranks, so with room in the budget the corrected advice was still injected
// beside the correction — in directives, or in the consider pool. Once the
// replacing engram is active, the superseded one is not current and is not
// injected at all; a historical prompt still reaches it (tests above).
describe('supersedes chain — a replaced engram is not injected as current', () => {
  const rel = (supersedes: string[], superseded_by: string[]) => ({
    broader: [], narrower: [], related: [], conflicts: [], supersedes, superseded_by,
  })
  const make = (overrides: Partial<any>) => EngramSchema.parse({
    type: 'behavioral', scope: 'global', status: 'active', ...overrides,
  })
  const allIds = (result: ReturnType<typeof selectAndSpread>) => [
    ...result.directives.map(e => e.id),
    ...result.constraints.map(e => e.id),
    ...result.consider.map(e => e.id),
  ]
  const tip = () => make({
    id: 'ENG-2026-0102-002',
    statement: 'deploy the website with the deploy.sh script, never npm run deploy',
    relations: rel(['ENG-2026-0102-001'], []),
  })
  const older = (extra: Partial<any> = {}) => make({
    id: 'ENG-2026-0102-001',
    statement: 'deploy the website with npm run deploy',
    relations: rel([], ['ENG-2026-0102-002']),
    ...extra,
  })

  it('with ample budget, the superseded engram is absent from every section', () => {
    const result = selectAndSpread(
      { prompt: 'how do I deploy the website', maxTokens: 5000 },
      [older(), tip()], [],
    )
    const ids = allIds(result)
    expect(ids).toContain('ENG-2026-0102-002')
    expect(ids).not.toContain('ENG-2026-0102-001')
  })

  it('an embedding boost does not bring the superseded engram back', () => {
    const boosts = new Map([['ENG-2026-0102-001', 0.95], ['ENG-2026-0102-002', 0.6]])
    const result = selectAndSpread(
      { prompt: 'how do I ship it', maxTokens: 5000 },
      [older(), tip()], [], undefined, boosts,
    )
    expect(allIds(result)).not.toContain('ENG-2026-0102-001')
  })

  it('spreading activation does not pull the superseded engram in through an association', () => {
    const t = tip()
    t.associations = [{ target_type: 'engram', target: 'ENG-2026-0102-001', type: 'co_accessed', strength: 0.9, updated_at: new Date().toISOString().slice(0, 10) }] as any
    // `older` scores 0 on this prompt, so the only way in is the spread.
    const o = older({ statement: 'unrelated wording entirely' })
    const result = selectAndSpread(
      { prompt: 'deploy.sh script website', maxTokens: 5000 },
      [o, t], [],
    )
    expect(allIds(result)).toContain('ENG-2026-0102-002')
    expect(allIds(result)).not.toContain('ENG-2026-0102-001')
  })

  it('when the replacing engram is not active here, the superseded engram stays injectable', () => {
    // The superseding engram lives elsewhere (e.g. a remote store) or was
    // retired: dropping the only local copy would lose the memory entirely.
    const retired = make({ ...tip(), status: 'retired' })
    const result = selectAndSpread(
      { prompt: 'how do I deploy the website', maxTokens: 5000 },
      [older(), retired], [],
    )
    expect(allIds(result)).toContain('ENG-2026-0102-001')
  })

  // The replacement must be one this session could actually deliver. If it is
  // skipped for delivery, dropping the old engram leaves the session with
  // neither — the old one is kept (at the ×0.3 re-rank) instead.
  const packOf = (policy: string, engrams: any[]) => ({
    manifest: { name: 'p', version: '1.0.0', metadata: { injection_policy: policy, match_terms: [] } },
    engrams,
  }) as never

  it('a draft replacement awaiting approval does not suppress the engram it supersedes (#1141)', () => {
    const draft = make({ ...tip(), commitment: 'draft' })
    const result = selectAndSpread(
      { prompt: 'how do I deploy the website', maxTokens: 5000 },
      [older(), draft], [],
    )
    const ids = allIds(result)
    expect(ids).toContain('ENG-2026-0102-001')
    expect(ids).not.toContain('ENG-2026-0102-002')
  })

  it('an expired replacement does not suppress the engram it supersedes', () => {
    const expired = make({ ...tip(), temporal: { learned_at: '2026-01-01', valid_until: '2026-01-31' } })
    const result = selectAndSpread(
      { prompt: 'how do I deploy the website', maxTokens: 5000 },
      [older(), expired], [],
    )
    const ids = allIds(result)
    expect(ids).toContain('ENG-2026-0102-001')
    expect(ids).not.toContain('ENG-2026-0102-002')
  })

  it('a replacement in an on_request pack does not suppress the engram it supersedes', () => {
    const result = selectAndSpread(
      { prompt: 'how do I deploy the website', maxTokens: 5000 },
      [older()], [packOf('on_request', [tip()])],
    )
    const ids = allIds(result)
    expect(ids).toContain('ENG-2026-0102-001')
    expect(ids).not.toContain('ENG-2026-0102-002')
  })

  it('a replacement in an injectable pack still suppresses the engram it supersedes (control)', () => {
    const result = selectAndSpread(
      { prompt: 'how do I deploy the website', maxTokens: 5000 },
      [older()], [packOf('always', [tip()])],
    )
    const ids = allIds(result)
    expect(ids).toContain('ENG-2026-0102-002')
    expect(ids).not.toContain('ENG-2026-0102-001')
  })

  // A supersede loop is not a replacement: before #1232 its members were
  // re-ranked ×0.3, and suppressing on it would make every member disappear.
  it('an engram that supersedes itself is still injected', () => {
    const self = make({
      id: 'ENG-2026-0102-001',
      statement: 'deploy the website with npm run deploy',
      relations: rel(['ENG-2026-0102-001'], ['ENG-2026-0102-001']),
    })
    const result = selectAndSpread(
      { prompt: 'how do I deploy the website', maxTokens: 5000 },
      [self], [],
    )
    expect(allIds(result)).toContain('ENG-2026-0102-001')
  })

  it('members of a supersede cycle are still injected', () => {
    const a = make({
      id: 'ENG-2026-0102-001',
      statement: 'deploy the website with npm run deploy',
      relations: rel(['ENG-2026-0102-002'], ['ENG-2026-0102-002']),
    })
    const b = make({
      id: 'ENG-2026-0102-002',
      statement: 'deploy the website with the deploy.sh script',
      relations: rel(['ENG-2026-0102-001'], ['ENG-2026-0102-001']),
    })
    const result = selectAndSpread(
      { prompt: 'how do I deploy the website', maxTokens: 5000 },
      [a, b], [],
    )
    const ids = allIds(result)
    expect(ids).toContain('ENG-2026-0102-001')
    expect(ids).toContain('ENG-2026-0102-002')
  })

  it('an engram outside a cycle is still suppressed by a cycle member that replaces it', () => {
    // older → B, and B ⇄ C loop. B does not lead back to `older`, so B is a
    // real replacement for it; B and C themselves are kept.
    const o = older()
    const b = make({
      id: 'ENG-2026-0102-002',
      statement: 'deploy the website with the deploy.sh script',
      relations: rel(['ENG-2026-0102-001', 'ENG-2026-0102-003'], ['ENG-2026-0102-003']),
    })
    const c = make({
      id: 'ENG-2026-0102-003',
      statement: 'deploy the website with the deploy.sh script and a dry run first',
      relations: rel(['ENG-2026-0102-002'], ['ENG-2026-0102-002']),
    })
    const result = selectAndSpread(
      { prompt: 'how do I deploy the website', maxTokens: 5000 },
      [o, b, c], [],
    )
    const ids = allIds(result)
    expect(ids).not.toContain('ENG-2026-0102-001')
    expect(ids).toContain('ENG-2026-0102-002')
    expect(ids).toContain('ENG-2026-0102-003')
  })

  it('a draft or expired replacement inside an injectable pack does not suppress the engram it supersedes', () => {
    // The pack loop has its own deliverability gate; the personal-loop tests
    // above do not reach it.
    for (const replacement of [
      make({ ...tip(), commitment: 'draft' }),
      make({ ...tip(), temporal: { learned_at: '2026-01-01', valid_until: '2026-01-31' } }),
    ]) {
      const result = selectAndSpread(
        { prompt: 'how do I deploy the website', maxTokens: 5000 },
        [older()], [packOf('always', [replacement])],
      )
      const ids = allIds(result)
      expect(ids).toContain('ENG-2026-0102-001')
      expect(ids).not.toContain('ENG-2026-0102-002')
    }
  })

  it('members of a supersede cycle inside a pack are still injected', () => {
    const a = make({
      id: 'ENG-2026-0102-001',
      statement: 'deploy the website with npm run deploy',
      relations: rel(['ENG-2026-0102-002'], ['ENG-2026-0102-002']),
    })
    const b = make({
      id: 'ENG-2026-0102-002',
      statement: 'deploy the website with the deploy.sh script',
      relations: rel(['ENG-2026-0102-001'], ['ENG-2026-0102-001']),
    })
    const result = selectAndSpread(
      { prompt: 'how do I deploy the website', maxTokens: 5000 },
      [], [packOf('always', [a, b])],
    )
    const ids = allIds(result)
    expect(ids).toContain('ENG-2026-0102-001')
    expect(ids).toContain('ENG-2026-0102-002')
  })

  it('a historical prompt still reaches the superseded engram', () => {
    const result = selectAndSpread(
      { prompt: 'how did we previously deploy the website', maxTokens: 5000 },
      [older(), tip()], [],
    )
    expect(allIds(result)).toContain('ENG-2026-0102-001')
  })
})
