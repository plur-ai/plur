import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

/**
 * Owner decisions 2026-10-18:
 *  - LRN-8: when the duplicate checker answers UPDATE, the incoming statement
 *    is saved as its own memory that supersedes the existing one
 *    (relations.supersedes / superseded_by). The existing text is never
 *    rewritten. Single learnAsync and learnBatch alike.
 *  - LRN-9: a LOCKED target is never superseded automatically. It stays
 *    unchanged and active, the new statement is saved, and a tension record
 *    (status detected) links the two, so the pair waits in the review queue.
 */

const OLD = 'Release notes go out to the mailing list every Monday.'
const NEW = 'Release notes go out to the mailing list every Thursday.'

const says = (target: () => string) => async () => `DECISION: UPDATE\nTARGET: ${target()}\nREASON: scripted`

type Path = 'single' | 'batch'

describe('a duplicate-check UPDATE supersedes, and a locked target goes to review', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-update-supersedes-'))
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function save(path: Path, llm: () => Promise<string>) {
    if (path === 'single') return plur.learnAsync(NEW, { scope: 'global', llm })
    const r = await plur.learnBatch([{ statement: NEW, context: { scope: 'global' } }], llm)
    expect(r.failures).toEqual([])
    return r.results[0]!
  }

  for (const path of ['single', 'batch'] as Path[]) {
    it(`${path}: UPDATE saves a new memory that supersedes the old one, old text kept`, async () => {
      const old = await plur.learn(OLD, { scope: 'global' })
      const r = await save(path, says(() => old.id))
      expect(r.decision).toBe('UPDATE')
      expect(r.existing_id).toBe(old.id)
      expect(r.engram.id).not.toBe(old.id)

      const fresh = new Plur({ path: dir })
      const oldNow = await fresh.getById(old.id)
      expect(oldNow?.statement).toBe(OLD)
      expect(oldNow?.relations?.superseded_by ?? []).toEqual([r.engram.id])
      const neu = await fresh.getById(r.engram.id)
      expect(neu?.statement).toBe(NEW)
      expect(neu?.relations?.supersedes ?? []).toEqual([old.id])
      expect(fresh.listTensions()).toEqual([])
    })

    it(`${path}: UPDATE onto a locked memory keeps it, saves the new one, and opens a review item`, async () => {
      const locked = await plur.learn(OLD, { scope: 'global', commitment: 'locked', locked_reason: 'test: owner rule' })
      const r = await save(path, says(() => locked.id))
      expect(r.decision).toBe('ADD')
      expect(r.engram.id).not.toBe(locked.id)

      const fresh = new Plur({ path: dir })
      const lockedNow = await fresh.getById(locked.id)
      expect(lockedNow?.statement).toBe(OLD)
      expect(lockedNow?.status).toBe('active')
      expect(lockedNow?.relations?.superseded_by ?? []).toEqual([])
      const neu = await fresh.getById(r.engram.id)
      expect(neu?.statement).toBe(NEW)
      expect(neu?.relations?.supersedes ?? []).toEqual([])

      const open = fresh.listTensions({ status: ['detected'] })
      expect(open).toHaveLength(1)
      expect([open[0].engram_a, open[0].engram_b].sort()).toEqual([locked.id, r.engram.id].sort())
      expect(r.tensions).toEqual([open[0].id])
    })
  }

  it('a memory locked after the checker read it, before the write, is not superseded either', async () => {
    const target = await plur.learn(OLD, { scope: 'global' })
    const other = new Plur({ path: dir })
    let decided = false
    let lockedInBetween = false
    const realGetById = plur.getById.bind(plur)
    ;(plur as unknown as { getById: typeof realGetById }).getById = async (id: string) => {
      const row = await realGetById(id)
      if (decided && id === target.id && !lockedInBetween) {
        const current = await other.getById(target.id)
        lockedInBetween = await other.updateEngram({
          ...current!, commitment: 'locked', locked_at: new Date().toISOString(), locked_reason: 'test: locked meanwhile',
        } as typeof current & object)
      }
      return row
    }
    const r = await plur.learnAsync(NEW, {
      scope: 'global',
      llm: async () => { decided = true; return `DECISION: UPDATE\nTARGET: ${target.id}\nREASON: scripted` },
    })
    expect(lockedInBetween, 'precondition: locked between the read and the write').toBe(true)

    const fresh = new Plur({ path: dir })
    const after = await fresh.getById(target.id)
    expect(after?.commitment).toBe('locked')
    expect(after?.statement).toBe(OLD)
    expect(after?.relations?.superseded_by ?? []).toEqual([])
    expect(r.decision).toBe('ADD')
    const open = fresh.listTensions({ status: ['detected'] })
    expect(open.map(t => [t.engram_a, t.engram_b].sort())).toEqual([[target.id, r.engram.id].sort()])
  })
})
