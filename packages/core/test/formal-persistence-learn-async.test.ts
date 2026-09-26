/**
 * Formal-verification replay (spec/formal/findings/persistence.md, candidate 7):
 * the dedup UPDATE/MERGE paths checked `commitment !== 'locked'` on a snapshot read
 * BEFORE taking the store lock, and wrote whatever row they re-read under it. An
 * engram locked in between was overwritten anyway.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { learnAsync, type LearnAsyncDeps } from '../src/learn-async.js'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'
import { EngramSchemaPassthrough, type Engram } from '../src/schemas/engram.js'

let root: string
beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), 'plur-flearn-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function target(locked: boolean): Engram {
  return EngramSchemaPassthrough.parse({
    id: 'ENG-2026-09-23-001', statement: 'the deploy host is alpha', type: 'behavioral',
    status: 'active', scope: 'local', ...(locked ? { commitment: 'locked' } : {}),
  }) as Engram
}

async function run(decision: 'UPDATE' | 'MERGE') {
  const store = new MemoryPrimaryStore()
  await store.save([target(true)]) // locked by the time the lock is taken
  const added: string[] = []
  const deps: LearnAsyncDeps = {
    hashDedup: async () => null,
    recallHybrid: async () => [target(false)],
    recall: async () => [target(false)],
    learn: async (s) => { added.push(s); return { ...target(false), id: 'ENG-2026-09-23-002', statement: s } as Engram },
    getById: async () => target(false), // the pre-lock snapshot: not yet locked
    store,
    engramsPath: join(root, 'engrams.yaml'),
    rootPath: root,
    dedupConfig: { enabled: true, mode: 'llm' },
    isLlmAvailable: () => true,
    recordLlmSuccess: () => {},
    recordLlmFailure: () => {},
    syncIndex: async () => {},
    offendingHitsForScope: () => [],
  }
  const res = await learnAsync(deps, 'the deploy host is beta', {
    scope: 'local',
    llm: async () => `DECISION: ${decision}\nTARGET: ENG-2026-09-23-001\nREASON: newer`,
  } as any)
  const after = (await store.load()).find(e => e.id === 'ENG-2026-09-23-001')!
  return { res, after, added }
}

describe('formal-persistence: learn-async respects a lock taken before the write lock', () => {
  for (const decision of ['UPDATE', 'MERGE'] as const) {
    it(`${decision} does not modify an engram that is locked under the store lock`, async () => {
      const { res, after, added } = await run(decision)
      expect(after.statement).toBe('the deploy host is alpha')
      expect(res.decision).toBe('ADD')
      expect(added).toEqual(['the deploy host is beta'])
    })
  }
})
