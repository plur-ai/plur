/**
 * Formal-verification replay (spec/formal/PlurSpec/WritePath.lean, candidate 5):
 * the tension gate on lock escalation, and readonly tension mutators.
 *
 *  - hasUnresolvedTension() caught the "unreadable tensions.yaml" error and
 *    answered false — "no tension" — so a corrupt file let contradicted
 *    knowledge escalate into 'locked', the one outcome #181 exists to prevent.
 *    loadTensions throws precisely so an unreadable file is never read as empty
 *    (#794 F1); the consumer undid that.
 *  - recordTensions / confirmTension / dismissTension / resolveTension had no
 *    _assertWritable(), so a readonly instance (#731) rewrote tensions.yaml.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, ReadonlyStoreError } from '../src/index.js'

const STATEMENT = 'the deploy window for the payment service is tuesday evening'

describe('formal WritePath — tension gate and readonly tension mutators (candidate 5)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-tension-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const tensionsPath = () => join(dir, 'tensions.yaml')
  const record = (a: string, b: string, status = 'detected') => ({
    id: 'T-2026-0923-001', engram_a: a, engram_b: b, statement_a: 'x', statement_b: 'y',
    confidence: 0.9, reason: 'contradiction', detected_at: '2026-09-23T00:00:00.000Z',
    status, resolved_by: null, resolved_at: null, category: 'factual',
  })

  /** Learn the same statement across scopes until the next hit would lock it. */
  async function decidedEngram(plur: Plur) {
    const e = await plur.learn(STATEMENT, { scope: 'project:a', type: 'behavioral' })
    await plur.learn(STATEMENT, { scope: 'project:b', type: 'behavioral' })
    await plur.learn(STATEMENT, { scope: 'project:c', type: 'behavioral' })
    const row = (await plur.getById(e.id))!
    expect(row.commitment, 'fixture: two cross-scope hits should reach decided').toBe('decided')
    return e
  }

  it('good case: a READABLE unresolved tension blocks lock escalation', async () => {
    const plur = new Plur({ path: dir })
    const e = await decidedEngram(plur)
    writeFileSync(tensionsPath(), yaml.dump([record(e.id, 'ENG-2026-09-23-999')]))
    await plur.learn(STATEMENT, { scope: 'project:d', type: 'behavioral' })
    expect((await plur.getById(e.id))!.commitment).toBe('decided')
  })

  it('an UNREADABLE tensions.yaml does not let the engram lock (fail closed)', async () => {
    const plur = new Plur({ path: dir })
    const e = await decidedEngram(plur)
    // A truncated write: content that parses to a non-list.
    writeFileSync(tensionsPath(), `- id: T-2026-0923-001\n  engram_a: ${e.id}\n  engram_b: [unterminated\n`)
    expect(() => plur.listTensions()).toThrow()
    expect(plur.hasUnresolvedTension(e.id), 'unreadable tension file answered "no tension"').toBe(true)
    await plur.learn(STATEMENT, { scope: 'project:d', type: 'behavioral' })
    expect((await plur.getById(e.id))!.commitment, 'escalated to locked past an unreadable tension file').toBe('decided')
  })

  it('a missing tensions.yaml still means no tension (the engram may lock)', async () => {
    const plur = new Plur({ path: dir })
    const e = await decidedEngram(plur)
    expect(plur.hasUnresolvedTension(e.id)).toBe(false)
    await plur.learn(STATEMENT, { scope: 'project:d', type: 'behavioral' })
    expect((await plur.getById(e.id))!.commitment).toBe('locked')
  })

  it('readonly: tension mutators throw ReadonlyStoreError and leave tensions.yaml untouched', async () => {
    writeFileSync(tensionsPath(), yaml.dump([record('ENG-A', 'ENG-B')]))
    const before = readFileSync(tensionsPath(), 'utf8')
    const ro = new Plur({ path: dir, readonly: true })
    expect(() => ro.confirmTension('T-2026-0923-001')).toThrow(ReadonlyStoreError)
    expect(() => ro.dismissTension('T-2026-0923-001')).toThrow(ReadonlyStoreError)
    await expect(ro.resolveTension('T-2026-0923-001', 'ENG-A')).rejects.toBeInstanceOf(ReadonlyStoreError)
    await expect(ro.recordTensions([{ id_a: 'ENG-C', id_b: 'ENG-D', statement_a: 'c', statement_b: 'd', confidence: 0.8, reason: 'r' }]))
      .rejects.toBeInstanceOf(ReadonlyStoreError)
    expect(readFileSync(tensionsPath(), 'utf8'), 'a readonly instance rewrote tensions.yaml').toBe(before)
  })
})
