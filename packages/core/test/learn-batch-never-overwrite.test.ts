import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

/**
 * Owner decision 2026-10-18: batch learning never overwrites an existing
 * memory. When the duplicate checker answers UPDATE or MERGE for a batch item,
 * the item is saved as its own memory, linked to the existing one
 * (relations.related) as a likely duplicate, and the per-item result says so.
 * NOOP still writes nothing and returns the existing id.
 *
 * Single learnAsync is not covered by this decision and keeps its behaviour.
 */

const OLD = 'Write release summaries as three bullets followed by one explicit next action.'
const INCOMING = 'Write release summaries as five bullets followed by one explicit next action.'

function scriptedChecker(decision: string, target: () => string) {
  const calls: string[] = []
  const llm = async (prompt: string): Promise<string> => {
    calls.push(prompt)
    return `DECISION: ${decision}\nTARGET: ${target()}\nREASON: scripted test checker`
  }
  return { llm, calls }
}

describe('learnBatch never overwrites an existing memory', () => {
  let plur: Plur
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-batch-never-overwrite-'))
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  for (const decision of ['UPDATE', 'MERGE'] as const) {
    it(`checker answers ${decision}: old text unchanged, new item saved and linked`, async () => {
      const old = await plur.learn(OLD, { scope: 'global' })
      const checker = scriptedChecker(decision, () => old.id)

      const res = await plur.learnBatch([{ statement: INCOMING, context: { scope: 'global' } }], checker.llm)

      expect(checker.calls.length, 'precondition: the duplicate checker was asked').toBeGreaterThan(0)
      expect(res.failures).toEqual([])
      const r = res.results[0]!

      // The existing memory is untouched, read fresh from disk.
      const fresh = new Plur({ path: dir })
      const oldNow = await fresh.getById(old.id)
      expect(oldNow?.statement).toBe(OLD)
      expect(oldNow?.status).toBe('active')
      expect(oldNow?.engram_version ?? 1).toBe(old.engram_version ?? 1)

      // The incoming item is its own memory, with its own text.
      expect(r.decision).toBe('ADD')
      expect(r.engram.id).not.toBe(old.id)
      const added = await fresh.getById(r.engram.id)
      expect(added?.statement).toBe(INCOMING)

      // Linked to the existing one as a likely duplicate, on disk.
      expect(added?.relations?.related ?? []).toContain(old.id)

      // And the per-item result says so plainly.
      expect(r.likely_duplicate_of?.id).toBe(old.id)
      expect(r.likely_duplicate_of?.checker_decision).toBe(decision)
      expect(r.likely_duplicate_of?.note).toMatch(/never overwrite/i)

      expect(res.stats.updated).toBe(0)
      expect(res.stats.merged).toBe(0)
      expect(res.stats.added).toBe(1)
    })
  }

  it('checker answers NOOP: nothing written, existing id returned', async () => {
    const old = await plur.learn(OLD, { scope: 'global' })
    const before = (await plur.list()).length
    const checker = scriptedChecker('NOOP', () => old.id)

    const res = await plur.learnBatch([{ statement: INCOMING, context: { scope: 'global' } }], checker.llm)

    expect(checker.calls.length).toBeGreaterThan(0)
    expect(res.results[0]!.decision).toBe('NOOP')
    expect(res.results[0]!.existing_id).toBe(old.id)
    expect(res.results[0]!.engram.id).toBe(old.id)
    expect((await plur.list()).length).toBe(before)
    expect((await plur.getById(old.id))?.statement).toBe(OLD)
  })

  it('locked target: still saved as its own memory, the locked one untouched', async () => {
    const old = await plur.learn(OLD, { scope: 'global', commitment: 'locked', locked_reason: 'test' })
    const checker = scriptedChecker('UPDATE', () => old.id)
    const res = await plur.learnBatch([{ statement: INCOMING, context: { scope: 'global' } }], checker.llm)
    expect(res.results[0]!.decision).toBe('ADD')
    expect((await plur.getById(old.id))?.statement).toBe(OLD)
    expect((await plur.getById(res.results[0]!.engram.id))?.statement).toBe(INCOMING)
  })

  it('single learnAsync keeps its behaviour: an UPDATE answer still updates (LRN-7 contract)', async () => {
    const old = await plur.learn(OLD, { scope: 'global' })
    const checker = scriptedChecker('UPDATE', () => old.id)
    const r = await plur.learnAsync(INCOMING, { scope: 'global', llm: checker.llm })
    expect(checker.calls.length).toBeGreaterThan(0)
    expect(r.decision).toBe('UPDATE')
    expect(r.likely_duplicate_of).toBeUndefined()
  })
})
