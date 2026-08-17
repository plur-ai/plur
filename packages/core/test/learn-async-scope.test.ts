import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { learnAsync } from '../src/learn-async.js'
import type { LearnAsyncDeps } from '../src/learn-async.js'
import { loadEngrams, saveEngrams } from '../src/engrams.js'
import type { Engram } from '../src/schemas/engram.js'

/**
 * Issue #359: LLM-dedup candidates were not scope-filtered, so a global engram
 * could absorb an explicitly-scoped write via NOOP/UPDATE/MERGE, silently dropping
 * the requested scope and leaving the team store empty.
 *
 * Fix: filter LLM-dedup candidates to context.scope before the LLM sees them,
 * mirroring the scope-awareness already present in hashDedup.
 */

const globalCandidate: Engram = {
  id: 'ENG-2026-0101-001',
  statement: 'PLUR positions Datafund as the data economy infrastructure layer',
  type: 'behavioral',
  domain: 'test',
  status: 'active',
  scope: 'global',
  version: 2,
  consolidated: false,
  visibility: 'private',
  tags: [],
  activation: { retrieval_strength: 0.8, storage_strength: 1.0, frequency: 3, last_accessed: '2026-06-01' },
  associations: [],
  knowledge_anchors: [],
  feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  pack: null,
  abstract: null,
  derived_from: null,
  derivation_count: 1,
  reference_count: 1,
  recurrence_count: 0,
  sources: [],
  engram_version: 1,
  episode_ids: [],
  polarity: null,
} as unknown as Engram

function makeDeps(candidates: Engram[]): LearnAsyncDeps {
  return {
    hashDedup: () => null,
    recallHybrid: async () => candidates,
    recall: () => candidates,
    learn: (statement: string, context?: any) =>
      ({ id: 'ENG-2026-0619-001', statement, scope: context?.scope ?? 'global' } as unknown as Engram),
    getById: (id: string) => candidates.find(c => c.id === id) ?? null,
    engramsPath: '/tmp/plur-test-engrams.yaml',
    rootPath: '/tmp/plur-test',
    dedupConfig: { enabled: true, mode: 'llm' },
    isLlmAvailable: () => true,
    recordLlmSuccess: () => {},
    recordLlmFailure: () => {},
    syncIndex: () => {},
    offendingHitsForScope: () => [],
  }
}

describe('learnAsync scope-aware LLM dedup (issue #359)', () => {
  it('does not dedup an explicitly-scoped write against a global engram', async () => {
    const llm = vi.fn().mockResolvedValue('NOOP')
    const deps = makeDeps([globalCandidate])

    const result = await learnAsync(
      deps,
      'PLUR positions Datafund as the data economy backbone',
      { scope: 'group:datafund/datafund', llm },
    )

    // The global candidate must be filtered out before the LLM is called.
    expect(llm).not.toHaveBeenCalled()
    // With no candidates, learnAsync falls through to ADD at the requested scope.
    expect(result.decision).toBe('ADD')
    expect(result.engram.scope).toBe('group:datafund/datafund')
  })

  it('still deduplicates same-scope candidates', async () => {
    const sameScope = { ...globalCandidate, id: 'ENG-2026-0101-002', scope: 'group:datafund/datafund' }
    const llm = vi.fn().mockResolvedValue('DECISION: NOOP\nTARGET: ENG-2026-0101-002\nREASON: identical content')
    const deps = makeDeps([sameScope as unknown as Engram])

    const result = await learnAsync(
      deps,
      'PLUR positions Datafund as the data economy backbone',
      { scope: 'group:datafund/datafund', llm },
    )

    // Same-scope candidate passes the filter; LLM is consulted.
    expect(llm).toHaveBeenCalled()
    expect(result.decision).toBe('NOOP')
    expect(result.existing_id).toBe('ENG-2026-0101-002')
  })

  it('does not filter candidates when no scope is requested', async () => {
    const llm = vi.fn().mockResolvedValue('DECISION: NOOP\nTARGET: ENG-2026-0101-001\nREASON: identical content')
    const deps = makeDeps([globalCandidate])

    const result = await learnAsync(
      deps,
      'PLUR positions Datafund as the data economy backbone',
      { llm },
    )

    // Without a requested scope the filter is skipped; global candidate is a valid target.
    expect(llm).toHaveBeenCalled()
    expect(result.decision).toBe('NOOP')
  })
})

// #484: async UPDATE/MERGE must increment `engram_version` (content-evolution
// counter used by previous_version chains), not `version` (schema-shape field).
describe('learnAsync UPDATE/MERGE increment engram_version not version (#484)', () => {
  let dir: string
  let engramsPath: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  function depsWithFile(candidates: Engram[]): LearnAsyncDeps {
    dir = mkdtempSync(join(tmpdir(), 'plur-484-'))
    engramsPath = join(dir, 'engrams.yaml')
    saveEngrams(engramsPath, candidates)
    return { ...makeDeps(candidates), engramsPath, rootPath: dir }
  }

  it('UPDATE increments engram_version and leaves version untouched', async () => {
    const seed = { ...globalCandidate, id: 'ENG-2026-0101-484a', scope: 'global', engram_version: 3, version: 2 } as unknown as Engram
    const deps = depsWithFile([seed])
    const llm = vi.fn().mockResolvedValue('DECISION: UPDATE\nTARGET: ENG-2026-0101-484a\nREASON: same topic')

    const result = await learnAsync(deps, 'updated statement', { llm })

    expect(result.decision).toBe('UPDATE')
    const persisted = loadEngrams(engramsPath).find(e => e.id === 'ENG-2026-0101-484a') as any
    expect(persisted.engram_version).toBe(4)   // incremented
    expect(persisted.version).toBe(2)           // schema-shape, untouched
  })

  it('MERGE increments engram_version and leaves version untouched', async () => {
    const seed = { ...globalCandidate, id: 'ENG-2026-0101-484b', scope: 'global', engram_version: 2, version: 2 } as unknown as Engram
    const deps = depsWithFile([seed])
    const llm = vi.fn().mockResolvedValue('DECISION: MERGE\nTARGET: ENG-2026-0101-484b\nREASON: complementary')

    const result = await learnAsync(deps, 'extra clause', { llm })

    expect(result.decision).toBe('MERGE')
    const persisted = loadEngrams(engramsPath).find(e => e.id === 'ENG-2026-0101-484b') as any
    expect(persisted.engram_version).toBe(3)   // incremented
    expect(persisted.version).toBe(2)           // schema-shape, untouched
  })
})

// #409: a dedup UPDATE/MERGE unions context.tags into the engram, but the demote
// scan only looked at the statement — a secret in a merged TAG reached the shared
// store unguarded. The demote now scans statement + tags.
describe('learnAsync demote scans merged tags (#409)', () => {
  let dir: string
  let engramsPath: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  function depsWithFile(candidates: Engram[]): LearnAsyncDeps {
    dir = mkdtempSync(join(tmpdir(), 'plur-409-'))
    engramsPath = join(dir, 'engrams.yaml')
    saveEngrams(engramsPath, candidates)
    return {
      ...makeDeps(candidates),
      engramsPath,
      rootPath: dir,
      // Flag any scan text containing the sentinel — placed ONLY in a tag below,
      // so a hit proves the scan now includes the merged tags.
      offendingHitsForScope: (text: string) =>
        text.includes('LEAKTAG') ? ([{ pattern: 'fake_infra', match: 'LEAKTAG' }] as any) : [],
    }
  }

  it('UPDATE demotes to local when a merged tag carries sensitive content', async () => {
    const shared = { ...globalCandidate, id: 'ENG-2026-0101-409', scope: 'group:datafund/datafund', statement: 'clean shared note' } as unknown as Engram
    const deps = depsWithFile([shared])
    const llm = vi.fn().mockResolvedValue('DECISION: UPDATE\nTARGET: ENG-2026-0101-409\nREASON: same topic')

    // Statement is clean; the sensitive sentinel rides ONLY in a tag.
    const result = await learnAsync(deps, 'clean shared note refined', { scope: 'group:datafund/datafund', tags: ['LEAKTAG'], llm })

    expect(result.decision).toBe('UPDATE')
    const persisted = loadEngrams(engramsPath).find(e => e.id === 'ENG-2026-0101-409') as any
    expect(persisted.scope).toBe('local')        // demoted — the merged tag was scanned
    expect(persisted.visibility).toBe('private')
  })

  it('UPDATE does NOT demote when statement and tags are clean (no over-block)', async () => {
    const shared = { ...globalCandidate, id: 'ENG-2026-0101-409b', scope: 'group:datafund/datafund', statement: 'clean shared note' } as unknown as Engram
    const deps = depsWithFile([shared])
    const llm = vi.fn().mockResolvedValue('DECISION: UPDATE\nTARGET: ENG-2026-0101-409b\nREASON: same topic')

    const result = await learnAsync(deps, 'clean shared note refined', { scope: 'group:datafund/datafund', tags: ['ordinary-tag'], llm })

    expect(result.decision).toBe('UPDATE')
    const persisted = loadEngrams(engramsPath).find(e => e.id === 'ENG-2026-0101-409b') as any
    expect(persisted.scope).toBe('group:datafund/datafund') // untouched
  })
})
