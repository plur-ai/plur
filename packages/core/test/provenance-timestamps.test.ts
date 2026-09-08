/**
 * The `created_at` / `updated_at` contract, asserted rather than documented.
 *
 * The fields were added with the rule written out in three places — the schema
 * descriptions, `spec/ENGRAM-STANDARD-v1.md` §4.2, and the changelog — and
 * verified in none. Checking the mutation sites by hand is how the gap in
 * `updateEngram` and `setPinned` was found in review: both wrote the engram
 * without moving `updated_at`, so the field equalled `created_at` for every
 * engram that had ever been edited. That is worse than an absent field, because
 * it reads as authoritative.
 *
 * The two halves of the contract:
 *
 *  - `created_at` is the first mint and is IMMUTABLE. Never synthesised at load
 *    time — a default stamps today's date onto every legacy record and destroys
 *    the provenance the field exists to carry.
 *  - `updated_at` tracks mutation of content or lifecycle. It MUST NOT move on
 *    reads, decay, injection or feedback; those change `activation` and
 *    `usage`, which carry their own timestamps. A field that moves on read is
 *    indistinguishable from `activation.last_accessed` and useless.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'

describe('created_at / updated_at provenance contract', () => {
  let dir: string
  let plur: Plur

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-provenance-'))
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    plur = new Plur({ path: dir })
    await plur.ready()
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const only = async () => (await plur.list())[0] as unknown as
    { id: string; created_at?: string; updated_at?: string; statement: string }

  it('stamps both on a new write', async () => {
    await plur.learn('Never force-push to main.', { scope: 'global' })
    const e = await only()
    expect(e.created_at).toBeTruthy()
    expect(e.updated_at).toBeTruthy()
    // A fresh engram has not been edited, so the two agree.
    expect(e.updated_at).toBe(e.created_at)
  })

  it('never synthesises them for a legacy engram that lacks them', async () => {
    // The failure this guards: a load-time default that stamps the load date
    // onto every pre-existing record. Absent must stay absent.
    writeFileSync(join(dir, 'engrams.yaml'),
      'engrams:\n'
      + '  - id: ENG-2026-0101-001\n'
      + '    statement: A legacy engram with no provenance timestamps.\n'
      + '    type: behavioral\n'
      + '    scope: global\n'
      + '    status: active\n')
    const legacy = new Plur({ path: dir })
    await legacy.ready()
    const e = (await legacy.list())[0] as unknown as { created_at?: string; updated_at?: string }
    expect(e.created_at).toBeUndefined()
    expect(e.updated_at).toBeUndefined()
  })

  it('moves updated_at on an edit, and leaves created_at alone', async () => {
    await plur.learn('Deploy on Tuesday.', { scope: 'global' })
    const before = await only()

    await new Promise(r => setTimeout(r, 2))
    const full = await plur.getById(before.id) as Engram
    await plur.updateEngram({ ...full, statement: 'Deploy on Wednesday.' })

    const after = await only()
    expect(after.statement).toBe('Deploy on Wednesday.')
    expect(after.created_at).toBe(before.created_at)
    expect(after.updated_at).not.toBe(before.updated_at)
    expect(Date.parse(after.updated_at!)).toBeGreaterThan(Date.parse(before.updated_at!))
  })

  it('moves updated_at when pinning — pinning is a mutation', async () => {
    await plur.learn('Credentials are never searched for.', { scope: 'global' })
    const before = await only()

    await new Promise(r => setTimeout(r, 2))
    await plur.setPinned(before.id, true)

    const after = await only()
    expect(after.created_at).toBe(before.created_at)
    expect(Date.parse(after.updated_at!)).toBeGreaterThan(Date.parse(before.updated_at!))
  })

  it('does NOT move updated_at on a read', async () => {
    await plur.learn('Reads must not look like writes.', { scope: 'global' })
    const before = await only()

    await new Promise(r => setTimeout(r, 2))
    await plur.recall('reads writes')
    await plur.getById(before.id)
    await plur.list()

    expect((await only()).updated_at).toBe(before.updated_at)
  })

  it('does NOT move updated_at on feedback', async () => {
    // Feedback changes activation and usage. If it moved updated_at too, the
    // field would be indistinguishable from activation.last_accessed — which is
    // exactly the confusion that made "Last verified" the wrong label for it.
    await plur.learn('Feedback is activation, not authorship.', { scope: 'global' })
    const before = await only()

    await new Promise(r => setTimeout(r, 2))
    await plur.feedback(before.id, 'positive')

    expect((await only()).updated_at).toBe(before.updated_at)
  })

  it('does NOT move updated_at on injection', async () => {
    await plur.learn('Injection is a read of the corpus.', { scope: 'global' })
    const before = await only()

    await new Promise(r => setTimeout(r, 2))
    await plur.inject('injection corpus read')

    expect((await only()).updated_at).toBe(before.updated_at)
  })
})
