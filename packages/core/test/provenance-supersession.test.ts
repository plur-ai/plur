/**
 * A memory that has been replaced must say so (#992).
 *
 * An agent tester found the old memory reporting `status: active`,
 * `complete: true`, `not_recorded: []` — actively asserting there was nothing
 * further to know — about a memory that had been corrected minutes earlier.
 *
 *   "I would have told my human that memory was reliable and current.
 *    It had been corrected five minutes earlier."
 *
 * The forward link existed: the replacement recorded `prov:wasRevisionOf`.
 * Asking about the memory you HAVE told you nothing about the memory that
 * replaced it, which is the direction a reader actually asks in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur, summariseProvenance } from '../src/index.js'

describe('a replaced memory says what replaced it', () => {
  let dir: string
  let oldId: string
  let newId: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-supersede-'))
    const plur = new Plur({ path: dir })
    oldId = (await plur.learn('The old fact about ports', { type: 'behavioral' })).id
    newId = (await plur.learn('The corrected fact about ports', {
      type: 'behavioral', supersedes: [oldId],
    })).id
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const summaryOf = async (id: string) => {
    const plur = new Plur({ path: dir })
    const record = await plur.provenanceFor(id, { mode: 'portable' })
    return summariseProvenance(record as any)
  }

  it('names the replacement when asked about the old memory', async () => {
    const s = await summaryOf(oldId)
    expect(s.fields.superseded_by).toEqual([newId])
  })

  it('never reports a replaced memory as complete', async () => {
    // Reporting "nothing is missing" about a withdrawn memory is the failure
    // that made a tester call this the most valuable fix in the tool.
    expect((await summaryOf(oldId)).complete).toBe(false)
  })

  it('lists the replacement among what a reader still needs to know', async () => {
    expect((await summaryOf(oldId)).missing.join(' ')).toContain('replaced by')
  })

  it('says it in the first line, not below the licence', async () => {
    // Somebody deciding whether to rely on this needs it before anything else.
    const s = await summaryOf(oldId)
    expect(s.lines[0]).toContain('SUPERSEDED')
  })

  it('records the link in the document as well as the summary', async () => {
    const plur = new Plur({ path: dir })
    const record: any = await plur.provenanceFor(oldId, { mode: 'portable' })
    const subject = record['@graph'].find((n: any) => n['@id'] === `engram:${oldId}`)
    expect(subject['engram:supersededBy']).toEqual([{ '@id': `engram:${newId}` }])
  })

  it('still records the forward link on the replacement', async () => {
    const plur = new Plur({ path: dir })
    const record: any = await plur.provenanceFor(newId, { mode: 'portable' })
    const subject = record['@graph'].find((n: any) => n['@id'] === `engram:${newId}`)
    expect(subject['prov:wasRevisionOf']).toEqual([{ '@id': `engram:${oldId}` }])
  })

  it('leaves an ordinary memory alone', async () => {
    const s = await summaryOf(newId)
    expect(s.fields.superseded_by).toBeUndefined()
    expect(s.lines[0]).not.toContain('SUPERSEDED')
  })
})
