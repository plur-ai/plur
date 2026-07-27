/**
 * Multi-writer safety on a shared Postgres store.
 *
 * This is the scenario the whole convergence programme exists to enable — more
 * than one process running core against one database — and it was BROKEN in a
 * way no existing test could see.
 *
 * `Plur`'s write methods are read-modify-write: load the corpus, change one
 * engram, save the corpus. `save()` replaces the whole corpus, so the loser of
 * a race does not merely lose its own update, it DELETES rows the winner had
 * already committed. The only mutual exclusion was `withAsyncLock` on
 * `paths.engrams` — an in-process mutex plus an `O_EXCL` file on the LOCAL
 * disk, which two processes sharing a database do not share.
 *
 * Before the fix, against this exact harness:
 *   - concurrent feedback + learn reverted the feedback increment, 5 runs of 5
 *   - concurrent read-only recall + learn DELETED the learned engram, 2 of 5
 *
 * The second is the one that should have blocked the release: `recall()`
 * updates activation, so a read is a whole-corpus write, and a read on one
 * worker permanently destroyed another worker's data.
 *
 * Two `Plur` instances with DIFFERENT `path:` directories model two processes:
 * distinct lock files, distinct in-process mutexes, one shared schema. If the
 * lock were still keyed on the local path these would fail.
 *
 * Gated on PLUR_TEST_POSTGRES_URL; fails rather than skips when it is set but
 * the database is unreachable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { PostgresAdapter } from '../src/storage-postgres.js'

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
const SCHEMA = 'plur_multi_writer'
const TIMEOUT = 180_000

describe.skipIf(!PG_URL)('two Plur instances sharing one Postgres store', () => {
  let a: PostgresAdapter
  let b: PostgresAdapter
  let p1: Plur
  let p2: Plur
  let dirA: string
  let dirB: string

  beforeEach(async () => {
    dirA = mkdtempSync(join(tmpdir(), 'plur-mw-a-'))
    dirB = mkdtempSync(join(tmpdir(), 'plur-mw-b-'))
    // Two adapters, one schema — the closest thing to two containers without
    // spawning processes. Distinct `path:` means distinct lock files.
    a = new PostgresAdapter({ connectionString: PG_URL!, schema: SCHEMA, vectorIndex: 'exact' })
    b = new PostgresAdapter({ connectionString: PG_URL!, schema: SCHEMA, vectorIndex: 'exact' })
    await a.save([])
    p1 = new Plur({ path: dirA, store: a })
    p2 = new Plur({ path: dirB, store: b })
    await p1.ready()
    await p2.ready()
  }, TIMEOUT)

  afterEach(async () => {
    await a?.dropSchema().catch(() => { /* best effort */ })
    await a?.close().catch(() => { /* best effort */ })
    await b?.close().catch(() => { /* best effort */ })
    if (dirA) rmSync(dirA, { recursive: true, force: true })
    if (dirB) rmSync(dirB, { recursive: true, force: true })
  }, TIMEOUT)

  it('keeps both engrams when two instances learn concurrently', async () => {
    const [e1, e2] = await Promise.all([
      p1.learn('statement written by instance one', { scope: 'global' }),
      p2.learn('statement written by instance two', { scope: 'global' }),
    ])

    expect(e1.id).not.toBe(e2.id)
    const rows = await a.load()
    const ids = rows.map(r => r.id)
    expect(ids, 'instance one lost its engram').toContain(e1.id)
    expect(ids, 'instance two lost its engram').toContain(e2.id)
  }, TIMEOUT)

  it('does not revert a feedback increment made by the other instance', async () => {
    // Reproduced 5/5 before the fix.
    const seed = await p1.learn('an engram whose feedback must survive', { scope: 'global' })
    await Promise.all([
      p2.feedback(seed.id, 'positive'),
      p1.learn('a concurrent unrelated write', { scope: 'global' }),
    ])

    const after = await p1.getById(seed.id)
    expect(after?.feedback_signals?.positive, 'feedback increment was reverted').toBe(1)
  }, TIMEOUT)

  it('a read-only recall on one instance does not delete the other\'s new engram', async () => {
    // Reproduced 2/5 before the fix, and the worst of the three: `recall()`
    // updates activation, so it is a whole-corpus write wearing a read's name.
    await p1.learn('widgets are assembled in the northern plant', { scope: 'global' })

    const [, created] = await Promise.all([
      p2.recall('widgets'),
      p1.learn('created while the other instance was recalling', { scope: 'global' }),
    ])

    const rows = await a.load()
    expect(rows.map(r => r.id), 'a read deleted a committed write').toContain(created.id)
  }, TIMEOUT)

  it('survives an interleaved fan-out across both instances', async () => {
    // Beyond the two-way races: alternate writers so load/save windows overlap
    // repeatedly rather than once.
    const N = 12
    const written = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        (i % 2 === 0 ? p1 : p2).learn(`interleaved write number ${i} about topic ${i}`, { scope: 'global' }),
      ),
    )

    expect(new Set(written.map(e => e.id)).size, 'two instances minted the same id').toBe(N)
    const stored = new Set((await a.load()).map(r => r.id))
    const missing = written.filter(e => !stored.has(e.id)).map(e => e.id)
    expect(missing, 'engrams reported as written were not persisted').toEqual([])
  }, TIMEOUT)

  it('releases the advisory lock when the critical section throws', async () => {
    // A lock leaked on the error path would deadlock every later writer, and
    // the symptom would be a hang rather than a failure.
    await expect(
      a.withExclusiveAccess(async () => { throw new Error('boom') }),
    ).rejects.toThrow('boom')

    // If the lock leaked, this never resolves and the test times out.
    const e = await p2.learn('written after a failed critical section', { scope: 'global' })
    expect((await a.load()).map(r => r.id)).toContain(e.id)
  }, TIMEOUT)
})
