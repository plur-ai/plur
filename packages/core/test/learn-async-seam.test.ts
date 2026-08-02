/**
 * The dedup UPDATE/MERGE paths must not whole-corpus-replace (issue #802,
 * audit #794 F3 remainder).
 *
 * `deps.store.save(engrams)` is a full replace on every backend. On Postgres it
 * finishes with
 *
 *   DELETE FROM engrams WHERE id NOT IN (<the ids being saved>)
 *
 * so every row absent from the array that call happened to load is deleted, and
 * an empty array deletes the table. It fires on ordinary `plur_learn` calls,
 * because UPDATE/MERGE is what LLM dedup returns whenever the incoming
 * statement resembles something already stored — which is the common case, not
 * an edge one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'
import type { Engram } from '../src/schemas/engram.js'
import { Plur } from '../src/index.js'

let root: string

/** Records which seam methods the write path actually used. */
class RecordingStore extends MemoryPrimaryStore {
  saveCalls: number[] = []
  updateManyCalls: string[][] = []
  appendCalls: string[] = []

  override async save(engrams: Engram[]): Promise<void> {
    this.saveCalls.push(engrams.length)
    return super.save(engrams)
  }
  override async updateMany(engrams: Engram[]): Promise<void> {
    this.updateManyCalls.push(engrams.map(e => e.id))
    return super.updateMany(engrams)
  }
  override async append(engram: Engram): Promise<void> {
    this.appendCalls.push(engram.id)
    return super.append(engram)
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'plur-seam-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('dedup writes go through the incremental seam (#802)', () => {
  it('an ordinary learn appends one row rather than replacing the corpus', async () => {
    const store = new RecordingStore()
    const plur = new Plur({ path: root, autoDiscover: false, store })
    for (let i = 0; i < 5; i++) await plur.learn(`distinct fact number ${i}`, { scope: 'local' })

    expect(store.appendCalls).toHaveLength(5)
    // The thing that must never happen on a capability store: a whole-corpus
    // replace on a plain write.
    expect(store.saveCalls).toEqual([])
  })

  it('updateMany carries exactly the changed row, never the whole corpus', async () => {
    const store = new RecordingStore()
    const plur = new Plur({ path: root, autoDiscover: false, store })
    const seeded = await plur.learn('the deployment host is example.internal', { scope: 'local' })
    for (let i = 0; i < 4; i++) await plur.learn(`unrelated fact ${i}`, { scope: 'local' })

    store.updateManyCalls = []
    store.saveCalls = []

    // feedback() is a seam write on an existing engram — the same shape the
    // dedup UPDATE path takes after #802.
    await plur.feedback(seeded.id, 'positive')

    expect(store.saveCalls, 'a single-engram change triggered a whole-corpus replace').toEqual([])
    expect(store.updateManyCalls.flat()).toContain(seeded.id)
    // Every engram still present.
    expect(await plur.list()).toHaveLength(5)
  })
})

describe('the seam refuses to empty a corpus it was not told to empty', () => {
  it('rejects an undeclared empty write on any backend', async () => {
    // Postgres' save() ends in an unqualified `DELETE FROM engrams` for an
    // empty array, so this floor is backend-independent by necessity.
    const store = new RecordingStore()
    const plur = new Plur({ path: root, autoDiscover: false, store })
    for (let i = 0; i < 3; i++) await plur.learn(`fact ${i}`, { scope: 'local' })

    await expect(
      (plur as any)._writeEngrams((plur as any).paths.engrams, []),
    ).rejects.toThrow(/refusing to write an empty corpus/i)

    expect(await plur.list()).toHaveLength(3)
  })

  it('allows an empty write when the caller declares it', async () => {
    const store = new RecordingStore()
    const plur = new Plur({ path: root, autoDiscover: false, store })
    await plur.learn('a fact that will be compacted away', { scope: 'local' })

    await expect(
      (plur as any)._writeEngrams((plur as any).paths.engrams, [], { allowShrink: true }),
    ).resolves.toBeUndefined()
  })
})
