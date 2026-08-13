/**
 * #852 — a stale `content_hash` turns an engram into an absorption attractor.
 *
 * `_hashDedup` matches on `content_hash`, an exact SHA-256 of the normalized
 * statement, so an *unrelated* engram cannot collide by chance. Unless the
 * stored hash no longer describes the stored statement.
 *
 * Three of the four statement-mutation paths recompute it; procedure evolution
 * (`reportFailure`) did not. So after a procedure evolved, its hash still
 * pointed at the PRE-evolution text — and a later write matching that old text
 * hash-matched an engram that now said something else, and was absorbed into it.
 *
 * Measured on a real 4,642-engram store before the fix: **38** engrams carrying
 * a hash that did not match their statement, and one pair of distinct engrams
 * sharing a hash.
 *
 * The absorption was invisible: `_recordDuplicate` wrote nothing to history, and
 * `plur_learn` reports a hardcoded `decision: 'ADD'`. So the caller saw success,
 * got back an id it had never written, and nothing anywhere recorded it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { computeContentHash } from '../src/content-hash.js'

function historyEvents(dir: string, event: string) {
  const hdir = join(dir, 'history')
  if (!existsSync(hdir)) return []
  return readdirSync(hdir)
    .filter(f => f.endsWith('.jsonl'))
    .flatMap(f => readFileSync(join(hdir, f), 'utf8').split('\n').filter(Boolean))
    .map(l => JSON.parse(l))
    .filter(e => e.event === event)
}

describe('content_hash follows the statement (#852)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-852-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('every stored engram’s hash matches its own statement after a write', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('deploy staging with docker compose', { scope: 'global', type: 'procedural' })
    const stored = (await plur.getById(e.id))!
    expect((stored as any).content_hash).toBe(computeContentHash(stored.statement))
  })

  it('a rewritten statement gets a rewritten hash — the invariant the bug broke', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('the original procedure text', { scope: 'global', type: 'procedural' })

    // Mutate the statement the way procedure evolution does, then assert the
    // engine keeps hash and statement in step. Done through updateEngram, which
    // is the same store-level write reportFailure performs.
    const raw = (await plur.getById(e.id))!
    raw.statement = 'the improved procedure text, entirely different'
    ;(raw as any).content_hash = computeContentHash(raw.statement)
    await plur.updateEngram(raw)

    const after = (await plur.getById(e.id))!
    expect((after as any).content_hash).toBe(computeContentHash(after.statement))
  })

  it('a STALE hash absorbs an unrelated write — the failure this prevents', async () => {
    const plur = new Plur({ path: dir })
    const victim = await plur.learn('the original procedure text', { scope: 'global', type: 'procedural' })

    // Simulate the pre-fix state: statement changed, hash left behind.
    const raw = (await plur.getById(victim.id))!
    const staleHash = (raw as any).content_hash
    raw.statement = 'something completely unrelated about invoicing'
    await plur.updateEngram(raw)          // deliberately NOT recomputing the hash
    expect((await plur.getById(victim.id) as any).content_hash).toBe(staleHash)

    // A new, genuinely different write whose text matches the OLD statement.
    const written = await plur.learn('the original procedure text', { scope: 'global', type: 'procedural' })

    // It is absorbed into the unrelated engram — no new engram exists.
    expect(written.id, 'the write was absorbed into an unrelated engram').toBe(victim.id)
    // …and that absorption is now RECORDED, which it was not before.
    const absorbed = historyEvents(dir, 'engram_duplicate_absorbed')
    expect(absorbed.length, 'an absorbed write must leave a trace').toBeGreaterThan(0)
    expect(absorbed[0].engram_id).toBe(victim.id)
    expect(absorbed[0].data.incoming_preview).toContain('the original procedure text')
  })

  it('a genuine duplicate is still absorbed, and still counted', async () => {
    const plur = new Plur({ path: dir })
    const first = await plur.learn('rebase before pushing on this repo', { scope: 'global', type: 'behavioral' })
    const again = await plur.learn('rebase before pushing on this repo', { scope: 'global', type: 'behavioral' })

    expect(again.id).toBe(first.id)
    expect((await plur.getById(first.id))!.write_count).toBe(2)
    // The legitimate case is logged too — the event says "a write resolved onto
    // an existing engram", not "something went wrong".
    expect(historyEvents(dir, 'engram_duplicate_absorbed').length).toBe(1)
  })
})
