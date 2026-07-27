import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { getCandidatePairs, scanForTensions } from '../src/tensions.js'

/**
 * #240 item 3: `supersedes` is a RELATION (graph edge), not a temporality
 * enum value. `learn(statement, { supersedes: [ids] })` writes
 * `relations.supersedes` on the new engram and the reverse
 * `relations.superseded_by` edge on each (local) target. The tension
 * scanner skips supersedes-linked pairs — an intentional update is not a
 * contradiction.
 */
describe('learn with supersedes (#240)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-supersedes-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes relations.supersedes on the new engram', async () => {
    const oldE = await plur.learn('plur cli version is 0.3.0')
    const newE = await plur.learn('plur cli version is 0.8.2', { supersedes: [oldE.id] })
    expect(newE.relations?.supersedes).toEqual([oldE.id])
  })

  it('writes the reverse superseded_by edge on the target engram', async () => {
    const oldE = await plur.learn('plur cli version is 0.3.0')
    const newE = await plur.learn('plur cli version is 0.8.2', { supersedes: [oldE.id] })
    const reloaded = await plur.getById(oldE.id)
    expect(reloaded?.relations?.superseded_by).toEqual([newE.id])
  })

  it('supports multiple superseded targets', async () => {
    const a = await plur.learn('war analysis uses 5 agents')
    const b = await plur.learn('war analysis uses 7 agents')
    const c = await plur.learn('war analysis uses 9 agents', { supersedes: [a.id, b.id] })
    expect(c.relations?.supersedes?.sort()).toEqual([a.id, b.id].sort())
    expect((await plur.getById(a.id))?.relations?.superseded_by).toEqual([c.id])
    expect((await plur.getById(b.id))?.relations?.superseded_by).toEqual([c.id])
  })

  it('ignores unknown target ids without failing the write', async () => {
    const e = await plur.learn('plur cli version is 0.8.2', { supersedes: ['ENG-0000-0000-999'] })
    expect(e.id).toMatch(/^ENG-/)
    expect(e.relations?.supersedes).toEqual(['ENG-0000-0000-999'])
  })

  it('does not duplicate the reverse edge when superseded twice', async () => {
    const oldE = await plur.learn('plur cli version is 0.3.0')
    const newE = await plur.learn('plur cli version is 0.8.2', { supersedes: [oldE.id] })
    // re-learn with a different statement superseding the same target
    const newer = await plur.learn('plur cli version is 0.9.0', { supersedes: [oldE.id] })
    const reloaded = await plur.getById(oldE.id)
    expect(reloaded?.relations?.superseded_by?.sort()).toEqual([newE.id, newer.id].sort())
    expect(new Set(reloaded?.relations?.superseded_by).size).toBe(reloaded?.relations?.superseded_by?.length)
  })

  it('preserves existing relations on the target when adding the reverse edge', async () => {
    const oldE = await plur.learn('plur cli version is 0.3.0')
    const stored = await plur.getById(oldE.id)!
    await plur.updateEngram({
      ...stored,
      relations: { broader: ['B1'], narrower: [], related: [], conflicts: [], supersedes: [], superseded_by: [] },
    })
    const newE = await plur.learn('plur cli version is 0.8.2', { supersedes: [oldE.id] })
    const reloaded = await plur.getById(oldE.id)
    expect(reloaded?.relations?.broader).toEqual(['B1'])
    expect(reloaded?.relations?.superseded_by).toEqual([newE.id])
  })

  it('supersedes-linked pairs are skipped by the tension scanner end-to-end', async () => {
    const oldE = await plur.learn('plur cli version is 0.3.0')
    await plur.learn('plur cli version is 0.8.2', { supersedes: [oldE.id] })
    const engrams = await plur.list()
    expect(getCandidatePairs(engrams)).toHaveLength(0)
    const llm = vi.fn(async () => 'CONTRADICTS: yes\nCONFIDENCE: 1.0\nREASON: Versions differ.')
    const result = await scanForTensions(engrams, llm)
    expect(result.pairs_checked).toBe(0)
    expect(llm).not.toHaveBeenCalled()
  })

  it('round-trips supersedes relations through YAML persistence', async () => {
    const oldE = await plur.learn('plur cli version is 0.3.0')
    const newE = await plur.learn('plur cli version is 0.8.2', { supersedes: [oldE.id] })
    // Fresh instance re-reads from disk
    const plur2 = new Plur({ path: dir })
    expect((await plur2.getById(newE.id))?.relations?.supersedes).toEqual([oldE.id])
    expect((await plur2.getById(oldE.id))?.relations?.superseded_by).toEqual([newE.id])
  })
})
