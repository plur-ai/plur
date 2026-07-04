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

  it('under budget pressure without historical keywords, superseded engram is penalized and tip wins', () => {
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

    // Very tight budget — only one fits
    const result = selectAndSpread(
      { prompt: 'deploy canary strategy', maxTokens: 80 },
      [tip, older], []
    )

    const ids = [
      ...result.directives.map(e => e.id),
      ...result.constraints.map(e => e.id),
      ...result.consider.map(e => e.id),
    ]
    // Tip should be selected, older should be demoted out under tight budget
    expect(ids).toContain(tip.id)
    expect(ids).not.toContain(older.id)
  })

  it('with historical keywords in prompt, superseded engrams are NOT penalized', () => {
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

    // With a generous budget, both should appear regardless of historical intent
    const result = selectAndSpread(
      { prompt: 'what was the old deploy canary strategy previously', maxTokens: 5000 },
      [tip, older], []
    )

    const ids = [
      ...result.directives.map(e => e.id),
      ...result.constraints.map(e => e.id),
      ...result.consider.map(e => e.id),
    ]
    // With historical keywords, older should NOT be penalized — both should appear
    expect(ids).toContain(tip.id)
    expect(ids).toContain(older.id)
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
})
