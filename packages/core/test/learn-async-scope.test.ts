import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { learnAsync } from '../src/learn-async.js'
import type { LearnAsyncDeps } from '../src/learn-async.js'
import { loadEngrams, saveEngrams } from '../src/engrams.js'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'
import { YamlPrimaryStore } from '../src/store/yaml-primary-store.js'
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
  write_count: 1,
  recurrence_count: 0,
  sources: [],
  engram_version: 1,
  episode_ids: [],
  polarity: null,
} as unknown as Engram

function makeDeps(candidates: Engram[]): LearnAsyncDeps {
  return {
    hashDedup: async () => null,
    recallHybrid: async () => candidates,
    recall: async () => candidates,
    // Echoes `supersedes` the way learn() writes `relations.supersedes`.
    learn: async (statement: string, context?: any) =>
      ({ id: 'ENG-2026-0619-001', statement, scope: context?.scope ?? 'global',
        ...(context?.supersedes?.length ? { relations: { supersedes: context.supersedes } } : {}) } as unknown as Engram),
    getById: async (id: string) => candidates.find(c => c.id === id) ?? null,
    store: new MemoryPrimaryStore(),
    engramsPath: '/tmp/plur-test-engrams.yaml',
    rootPath: '/tmp/plur-test',
    dedupConfig: { enabled: true, mode: 'llm' },
    isLlmAvailable: () => true,
    recordLlmSuccess: () => {},
    recordLlmFailure: () => {},
    syncIndex: async () => {},
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
describe('learnAsync UPDATE/MERGE never move the existing engram_version or version (#484, LRN-7, LRN-8)', () => {
  let dir: string
  let engramsPath: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  function depsWithFile(candidates: Engram[]): LearnAsyncDeps {
    dir = mkdtempSync(join(tmpdir(), 'plur-484-'))
    engramsPath = join(dir, 'engrams.yaml')
    saveEngrams(engramsPath, candidates)
    return { ...makeDeps(candidates), engramsPath, rootPath: dir, store: new YamlPrimaryStore(engramsPath) }
  }

  // LRN-8 (owner decision 2026-10-18): UPDATE saves a new memory that
  // supersedes the old one; the old row is not rewritten, so neither of its
  // version fields moves. (Previously: engram_version incremented in place.)
  it('UPDATE leaves the existing engram_version and version untouched (it supersedes)', async () => {
    const seed = { ...globalCandidate, id: 'ENG-2026-0101-484a', scope: 'global', engram_version: 3, version: 2 } as unknown as Engram
    const deps = depsWithFile([seed])
    const llm = vi.fn().mockResolvedValue('DECISION: UPDATE\nTARGET: ENG-2026-0101-484a\nREASON: same topic')

    const result = await learnAsync(deps, 'updated statement', { llm })

    expect(result.decision).toBe('UPDATE')
    expect(result.existing_id).toBe('ENG-2026-0101-484a')
    expect(result.engram.id).not.toBe('ENG-2026-0101-484a')
    const persisted = loadEngrams(engramsPath).find(e => e.id === 'ENG-2026-0101-484a') as any
    expect(persisted.statement).toBe(seed.statement)
    expect(persisted.engram_version).toBe(3)
    expect(persisted.version).toBe(2)
  })

  // LRN-7 (owner decision 2026-10-18): a MERGE answer never rewrites the
  // target in a single save either; the statement is saved as its own memory,
  // linked to the target. Neither version field of the target moves.
  // (Previously: the statements were concatenated and engram_version incremented.)
  it('MERGE leaves the existing engram untouched and saves a linked memory', async () => {
    const seed = { ...globalCandidate, id: 'ENG-2026-0101-484b', scope: 'global', engram_version: 2, version: 2 } as unknown as Engram
    const deps = depsWithFile([seed])
    const learned: any[] = []
    const baseLearn = deps.learn
    deps.learn = async (statement: string, context?: any) => { learned.push({ statement, context }); return baseLearn(statement, context) }
    const llm = vi.fn().mockResolvedValue('DECISION: MERGE\nTARGET: ENG-2026-0101-484b\nREASON: complementary')

    const result = await learnAsync(deps, 'extra clause', { llm })

    expect(result.decision).toBe('ADD')
    expect(result.likely_duplicate_of?.id).toBe('ENG-2026-0101-484b')
    expect(result.likely_duplicate_of?.checker_decision).toBe('MERGE')
    expect(learned).toHaveLength(1)
    expect(learned[0].statement).toBe('extra clause')
    expect(learned[0].context.related).toEqual(['ENG-2026-0101-484b'])
    const persisted = loadEngrams(engramsPath).find(e => e.id === 'ENG-2026-0101-484b') as any
    expect(persisted.statement).toBe(seed.statement)
    expect(persisted.engram_version).toBe(2)
    expect(persisted.version).toBe(2)
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
      store: new YamlPrimaryStore(engramsPath),
      // Flag any scan text containing the sentinel — placed ONLY in a tag below,
      // so a hit proves the scan now includes the merged tags.
      offendingHitsForScope: (text: string) =>
        text.includes('LEAKTAG') ? ([{ pattern: 'fake_infra', match: 'LEAKTAG' }] as any) : [],
    }
  }

  // LRN-8 (owner decision 2026-10-18): UPDATE no longer unions tags into the
  // existing shared engram, so a sensitive tag cannot reach it at all. The new
  // memory, tags included, is written through learn(), whose own
  // sensitive-scope guard scans it. (Previously: the existing engram was
  // demoted in place.)
  it('UPDATE never carries a sensitive tag into the existing shared engram', async () => {
    const shared = { ...globalCandidate, id: 'ENG-2026-0101-409', scope: 'group:datafund/datafund', statement: 'clean shared note' } as unknown as Engram
    const deps = depsWithFile([shared])
    const learned: Array<{ statement: string; context: any }> = []
    const learn = deps.learn
    deps.learn = async (statement, context) => { learned.push({ statement, context }); return learn(statement, context) }
    const llm = vi.fn().mockResolvedValue('DECISION: UPDATE\nTARGET: ENG-2026-0101-409\nREASON: same topic')

    // Statement is clean; the sensitive sentinel rides ONLY in a tag.
    const result = await learnAsync(deps, 'clean shared note refined', { scope: 'group:datafund/datafund', tags: ['LEAKTAG'], llm })

    expect(result.decision).toBe('UPDATE')
    const persisted = loadEngrams(engramsPath).find(e => e.id === 'ENG-2026-0101-409') as any
    expect(persisted.statement).toBe('clean shared note')
    expect(persisted.tags).not.toContain('LEAKTAG')
    // The tag goes to learn(), where the sensitive-scope guard runs.
    expect(learned).toHaveLength(1)
    expect(learned[0].context.tags).toContain('LEAKTAG')
    expect(learned[0].context.supersedes).toEqual(['ENG-2026-0101-409'])
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
