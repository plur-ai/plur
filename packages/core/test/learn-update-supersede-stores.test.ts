import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import type { Engram, InjectionResult } from '../src/index.js'

/**
 * Audit 5, F3 and F4.
 *
 * F3 (LRN-9, INJ-4): a duplicate-check UPDATE onto a memory that is locked
 * between the checker's read and the write must never leave the replacement
 * deliverable, not even for a moment: it is a draft in the same write that
 * saves it, and a process that dies right after that write leaves a draft.
 *
 * F4 (LRN-8, COR-1, COR-3): an UPDATE is reported only when the replaced
 * memory is actually suppressed. A target in a writable secondary store gets
 * its reverse superseded_by edge in its own store; a target that cannot be
 * written (readonly store, pack) is not reported as UPDATE: the new memory is
 * saved as an ADD linked to it.
 */

const OLD = 'Release notes go out to the mailing list every Monday.'
const NEW = 'Release notes go out to the mailing list every Thursday.'
const TASK = 'when do release notes go out to the mailing list'
const SIDE = 'project:side'
const NEIGHBOUR = 'Release notes for the mailing list include a changelog section.'

const says = (target: () => string) => async () => `DECISION: UPDATE\nTARGET: ${target()}\nREASON: scripted`

function given(r: InjectionResult): string[] {
  const text = [r.directives, r.constraints, r.consider].filter(s => s.length > 0).join('\n')
  return [...new Set([...text.matchAll(/\[(ENG-[^\]\s]+)\]/g)].map(m => m[1]))]
}

async function rowWith(plur: Plur, statement: string): Promise<Engram> {
  const rows = (await plur.recall(statement, { limit: 20 })).filter(e => e.statement === statement)
  expect(rows, `precondition: exactly one row says "${statement}"`).toHaveLength(1)
  return rows[0]
}

describe('UPDATE across stores: reported only when the target is actually suppressed (F4)', () => {
  let dir: string
  let side: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-a5-main-'))
    side = mkdtempSync(join(tmpdir(), 'plur-a5-side-'))
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    writeFileSync(join(side, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(side, { recursive: true, force: true })
  })

  async function secondary(readonly: boolean): Promise<{ plur: Plur; target: Engram; sidePlur: Plur; sideId: string }> {
    const sidePlur = new Plur({ path: side })
    const sideRow = await sidePlur.learn(OLD, { scope: SIDE })
    const plur = new Plur({ path: dir })
    plur.addStore(join(side, 'engrams.yaml'), SIDE, { shared: false, readonly })
    const target = await rowWith(plur, OLD)
    expect(target.id, 'precondition: the target is served from the secondary store').not.toBe(sideRow.id)
    return { plur, target, sidePlur, sideId: sideRow.id }
  }

  it('primary target: both edges, old one no longer given', async () => {
    const plur = new Plur({ path: dir })
    const old = await plur.learn(OLD, { scope: SIDE })
    const r = await plur.learnAsync(NEW, { scope: SIDE, llm: says(() => old.id) })
    expect(r.decision).toBe('UPDATE')
    const fresh = new Plur({ path: dir })
    expect((await fresh.getById(old.id))?.relations?.superseded_by).toEqual([r.engram.id])
    expect((await fresh.getById(r.engram.id))?.relations?.supersedes).toEqual([old.id])
    const ids = given(await fresh.inject(TASK, { budget: 4000 }))
    expect(ids).toContain(r.engram.id)
    expect(ids).not.toContain(old.id)
  })

  it('writable secondary target: the reverse edge lands in its own store and it is no longer given', async () => {
    const { plur, target, sideId } = await secondary(false)
    const r = await plur.learnAsync(NEW, { scope: SIDE, llm: says(() => target.id) })
    expect(r.decision).toBe('UPDATE')
    expect(r.existing_id).toBe(target.id)

    const sideNow = await new Plur({ path: side }).getById(sideId)
    expect(sideNow?.statement).toBe(OLD)
    expect(sideNow?.relations?.superseded_by ?? [], 'reverse edge in the target\'s own store').toEqual([r.engram.id])

    const fresh = new Plur({ path: dir })
    fresh.addStore(join(side, 'engrams.yaml'), SIDE, { shared: false, readonly: false })
    expect((await fresh.getById(r.engram.id))?.relations?.supersedes).toEqual([target.id])
    const ids = given(await fresh.inject(TASK, { budget: 4000 }))
    expect(ids).toContain(r.engram.id)
    expect(ids, 'an UPDATE was reported but the replaced memory is still given').not.toContain(target.id)
  })

  it('readonly secondary target: not reported as UPDATE; saved as an ADD linked to it, target untouched', async () => {
    const { plur, target, sideId } = await secondary(true)
    // Readonly rows are not offered as candidates; a writable neighbour makes the
    // checker run, and the checker names the readonly row anyway.
    await plur.learn(NEIGHBOUR, { scope: SIDE })
    const r = await plur.learnAsync(NEW, { scope: SIDE, llm: says(() => target.id) })
    expect(r.decision).toBe('ADD')
    expect(r.engram.relations?.supersedes ?? []).toEqual([])
    expect(r.engram.relations?.related ?? []).toContain(target.id)
    expect(r.likely_duplicate_of?.id).toBe(target.id)
    const sideNow = await new Plur({ path: side }).getById(sideId)
    expect(sideNow?.relations?.superseded_by ?? []).toEqual([])
  })

  it('pack target: not reported as UPDATE; saved as an ADD linked to it', async () => {
    const plur = new Plur({ path: dir })
    const src = join(dir, 'pk-source')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), '---\nname: pk\nversion: "1.0"\n---\n')
    writeFileSync(join(src, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0728-901
    statement: ${OLD}
    type: behavioral
    scope: global
    status: active
    version: 2
    activation:
      retrieval_strength: 0.9
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-07-28"
`)
    await plur.installPack(src)
    const target = await rowWith(plur, OLD)
    await plur.learn(NEIGHBOUR, { scope: 'global' })
    const r = await plur.learnAsync(NEW, { scope: 'global', llm: says(() => target.id) })
    expect(r.decision).toBe('ADD')
    expect(r.engram.relations?.supersedes ?? []).toEqual([])
    expect(r.engram.relations?.related ?? []).toContain(target.id)
  })

  it('secondary target locked between the read and the write: not superseded, the new one is a draft, review opened', async () => {
    const { plur, target, sideId } = await secondary(false)
    const locker = new Plur({ path: side })
    let decided = false
    let locked = false
    const realGetById = plur.getById.bind(plur)
    ;(plur as unknown as { getById: typeof realGetById }).getById = async (id: string) => {
      const row = await realGetById(id)
      if (decided && id === target.id && !locked) {
        const cur = await locker.getById(sideId)
        locked = await locker.updateEngram({ ...cur!, commitment: 'locked', locked_at: new Date().toISOString(), locked_reason: 'test' } as Engram)
      }
      return row
    }
    const r = await plur.learnAsync(NEW, { scope: SIDE, llm: async () => { decided = true; return `DECISION: UPDATE\nTARGET: ${target.id}\nREASON: scripted` } })
    expect(locked, 'precondition: locked in between').toBe(true)
    expect(r.decision).toBe('ADD')
    const sideNow = await new Plur({ path: side }).getById(sideId)
    expect(sideNow?.commitment).toBe('locked')
    expect(sideNow?.relations?.superseded_by ?? []).toEqual([])
    const fresh = new Plur({ path: dir })
    expect((await fresh.getById(r.engram.id))?.commitment).toBe('draft')
    expect(r.tensions?.length).toBe(1)
  })
})

describe('late lock: the replacement is a draft from its very first write (F3)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-a5-late-'))
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Lock the target after the checker answered, then observe the store right after the first save. */
  async function interleave(plur: Plur, target: Engram, atFirstSave: (newId: string) => Promise<void>) {
    const other = new Plur({ path: dir })
    let decided = false
    let lockedInBetween = false
    const realGetById = plur.getById.bind(plur)
    ;(plur as unknown as { getById: typeof realGetById }).getById = async (id: string) => {
      const row = await realGetById(id)
      if (decided && id === target.id && !lockedInBetween) {
        const cur = await other.getById(target.id)
        lockedInBetween = await other.updateEngram({ ...cur!, commitment: 'locked', locked_at: new Date().toISOString(), locked_reason: 'test' } as Engram)
      }
      return row
    }
    const realLearn = plur.learn.bind(plur)
    let observed = false
    ;(plur as unknown as { learn: typeof realLearn }).learn = async (s, c) => {
      const saved = await realLearn(s, c)
      if (s === NEW && !observed) { observed = true; await atFirstSave(saved.id) }
      return saved
    }
    const run = plur.learnAsync(NEW, { scope: 'global', llm: async () => { decided = true; return `DECISION: UPDATE\nTARGET: ${target.id}\nREASON: scripted` } })
    return { run, check: () => { expect(lockedInBetween, 'precondition: locked in between').toBe(true); expect(observed, 'precondition: first save observed').toBe(true) } }
  }

  it('observe then inject between the first save and the end of the call: never active, never given', async () => {
    const plur = new Plur({ path: dir })
    const target = await plur.learn(OLD, { scope: 'global' })
    const { run, check } = await interleave(plur, target, async (newId) => {
      const fresh = new Plur({ path: dir })
      expect((await fresh.getById(newId))?.commitment, 'persisted row right after the first save').toBe('draft')
      const ids = given(await fresh.inject(TASK, { budget: 4000 }))
      expect(ids).toContain(target.id)
      expect(ids, 'the unapproved replacement was given before it became a draft').not.toContain(newId)
    })
    const r = await run
    check()
    expect(r.decision).toBe('ADD')
    expect(r.tensions?.length).toBe(1)
  })

  it('a process that dies right after the first save leaves a draft, not an active replacement', async () => {
    const plur = new Plur({ path: dir })
    const target = await plur.learn(OLD, { scope: 'global' })
    let newId = ''
    const { run, check } = await interleave(plur, target, async (id) => { newId = id; throw new Error('process died') })
    await expect(run).rejects.toThrow('process died')
    check()
    const restarted = new Plur({ path: dir })
    expect((await restarted.getById(newId))?.commitment).toBe('draft')
    expect(given(await restarted.inject(TASK, { budget: 4000 }))).not.toContain(newId)
  })

  it('a review that cannot be opened is reported in the result, not only logged', async () => {
    const plur = new Plur({ path: dir })
    const target = await plur.learn(OLD, { scope: 'global', commitment: 'locked', locked_reason: 'test' })
    ;(plur as unknown as { recordTensions: () => Promise<never> }).recordTensions = async () => { throw new Error('disk full') }
    const r = await plur.learnAsync(NEW, { scope: 'global', llm: says(() => target.id) })
    expect(r.decision).toBe('ADD')
    expect(r.tensions).toBeUndefined()
    expect(r.review_error).toMatch(/disk full/)
  })
})
