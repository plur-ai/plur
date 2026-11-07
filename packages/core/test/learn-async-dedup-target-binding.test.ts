// Security audit 2026-11-06: the TARGET id in the dedup model's reply is
// free-form model output. It must be one of the candidates the prompt showed
// (already filtered to the requested scope); any other id is treated as no
// match, so a scoped write can neither supersede nor be absorbed by an engram
// in another scope or store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { learnAsync, type LearnAsyncDeps } from '../src/learn-async.js'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'
import type { Engram } from '../src/schemas/engram.js'

const base = {
  type: 'behavioral', domain: 'test', status: 'active', version: 2, consolidated: false, visibility: 'private',
  tags: [], activation: { retrieval_strength: 0.8, storage_strength: 1.0, frequency: 3, last_accessed: '2026-06-01' },
  associations: [], knowledge_anchors: [], feedback_signals: { positive: 0, negative: 0, neutral: 0 }, pack: null,
  abstract: null, derived_from: null, derivation_count: 1, write_count: 1, recurrence_count: 0, sources: [],
  engram_version: 1, episode_ids: [], polarity: null,
}
const candidate = { ...base, id: 'ENG-2026-0101-010', scope: 'group:acme/eng', statement: 'Deploys go out on Tuesdays' } as unknown as Engram
// Never a candidate: a personal engram in another scope, reachable by id only.
const foreign = { ...base, id: 'ENG-2026-0101-099', scope: 'global', statement: 'My personal deploy checklist' } as unknown as Engram

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-dedup-target-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function makeDeps() {
  const learned: Array<{ statement: string; context: any }> = []
  const deps: LearnAsyncDeps = {
    hashDedup: async () => null,
    recallHybrid: async () => [candidate, foreign],
    recall: async () => [candidate, foreign],
    learn: async (statement: string, context?: any) => {
      learned.push({ statement, context })
      return { ...base, id: 'ENG-2026-1106-001', statement, scope: context?.scope ?? 'global',
        ...(context?.supersedes?.length ? { relations: { supersedes: context.supersedes } } : {}) } as unknown as Engram
    },
    // Resolves across every store, as the real getById does.
    getById: async (id: string) => [candidate, foreign].find(c => c.id === id) ?? null,
    store: new MemoryPrimaryStore(),
    engramsPath: join(dir, 'engrams.yaml'),
    rootPath: dir,
    dedupConfig: { enabled: true, mode: 'llm' },
    isLlmAvailable: () => true,
    recordLlmSuccess: () => {},
    recordLlmFailure: () => {},
    syncIndex: async () => {},
    offendingHitsForScope: () => [],
  }
  return { deps, learned }
}

describe('dedup TARGET must be one of the offered candidates', () => {
  for (const decision of ['UPDATE', 'NOOP', 'MERGE']) {
    it(`${decision} naming an engram that was not offered is treated as ADD`, async () => {
      const { deps, learned } = makeDeps()
      const llm = vi.fn().mockResolvedValue(`DECISION: ${decision}\nTARGET: ${foreign.id}\nREASON: injected`)
      const result = await learnAsync(deps, 'Deploys go out on Tuesday mornings', { scope: 'group:acme/eng', llm })
      expect(llm).toHaveBeenCalled()
      expect(llm.mock.calls[0][0]).not.toContain(foreign.id)
      expect(result.decision).toBe('ADD')
      expect(result.engram.id).not.toBe(foreign.id)
      expect(learned).toHaveLength(1)
      expect(learned[0].context?.scope).toBe('group:acme/eng')
      expect(learned[0].context?.supersedes ?? []).not.toContain(foreign.id)
      expect(learned[0].context?.related ?? []).not.toContain(foreign.id)
    })
  }
  it('a target that was offered still works (NOOP)', async () => {
    const { deps, learned } = makeDeps()
    const llm = vi.fn().mockResolvedValue(`DECISION: NOOP\nTARGET: ${candidate.id}\nREASON: identical`)
    const result = await learnAsync(deps, 'Deploys go out on Tuesdays', { scope: 'group:acme/eng', llm })
    expect(result.decision).toBe('NOOP')
    expect(result.existing_id).toBe(candidate.id)
    expect(learned).toHaveLength(0)
  })
})
