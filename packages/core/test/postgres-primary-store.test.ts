/**
 * THE ACCEPTANCE TEST for convergence Phase 2b.
 *
 * The whole point of flipping core's write path to async was this: let `Plur`
 * itself run on a Postgres primary store, so a multi-tenant server deployment
 * can stop reimplementing the memory engine and just run core.
 *
 * Until now it could not. From the `Plur` constructor, before this phase:
 *
 *   > The `postgres` tier cannot yet BE this process's primary store: `Plur`'s
 *   > write path is synchronous (ADR-0003) and Node has no synchronous Postgres
 *   > client, so a network-backed store cannot satisfy the `PrimaryStore`
 *   > contract until convergence Phase 2 makes that path async.
 *
 * That is a hard constraint, not a preference — there is no synchronous
 * Postgres driver for Node, and manufacturing one (block-on-promise, a sync
 * subprocess) trades a documented limitation for an undocumented hazard.
 *
 * So this file asserts the one thing that proves the constraint is gone: a
 * `Plur` whose primary store IS a `PostgresAdapter`, doing real work against a
 * real Postgres. Not a mock, not PGLite — the same engine a server deployment
 * would run.
 *
 * A test count cannot demonstrate this. This can.
 *
 * Gated on PLUR_TEST_POSTGRES_URL. When the variable is set but the database is
 * unreachable, it FAILS rather than skips: a silent skip on a configured
 * environment is how a green suite ends up meaning nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { PostgresAdapter } from '../src/storage-postgres.js'

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
const SCHEMA = 'plur_phase2b_acceptance'
const TIMEOUT = 120_000

describe.skipIf(!PG_URL)('Phase 2b acceptance — Plur on a Postgres primary store', () => {
  let adapter: PostgresAdapter
  let plur: Plur
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pg-primary-'))
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: SCHEMA, vectorIndex: 'exact' })
    // Touch it eagerly so a broken database fails HERE, loudly, rather than
    // being mistaken for "nothing to test".
    await adapter.save([])            // also starts from a known-empty store
    // `path` still supplies config/history locations; the STORE is Postgres.
    plur = new Plur({ path: dir, store: adapter })
  }, TIMEOUT)

  afterAll(async () => {
    if (adapter) {
      await adapter.dropSchema().catch(() => { /* best effort */ })
      await adapter.close().catch(() => { /* best effort */ })
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, TIMEOUT)

  it('reports Postgres as its primary store, not a fallback tier', () => {
    // Assert on the ENGINE, not on the adapter we just built. `adapter.kind`
    // and `typeof plur.status` hold whether or not `Plur` adopted the store —
    // they would both be green on the pre-flip code this test exists to
    // distinguish from. `plur.primaryStore` is the store the engine actually
    // persists through: before this phase the constructor logged a warning and
    // quietly kept a YAML one. If this is 'yaml', the flip did not land.
    expect(plur.primaryStore.kind).toBe('postgres')
    // ...and it is THIS adapter, not some other Postgres store it built itself.
    expect(plur.primaryStore).toBe(adapter)
  })

  it('round-trips learn -> recall through Postgres', async () => {
    const e = await plur.learn('the deploy pipeline runs migrations before the health check', {
      scope: 'global',
      type: 'procedural',
    })
    expect(e.id).toBeTruthy()

    // Straight back out of the engine...
    const byId = await plur.getById(e.id)
    expect(byId?.statement).toContain('migrations before the health check')

    // ...and through retrieval, which is the part that matters.
    const hits = await plur.recall('deploy pipeline migrations')
    expect(hits.map(h => h.id)).toContain(e.id)
  }, TIMEOUT)

  it('persists across a NEW Plur instance sharing the same Postgres store', async () => {
    const marker = 'postgres primary store survives an engine restart'
    const written = await plur.learn(marker, { scope: 'global', type: 'behavioral' })

    // A second engine over the same adapter — the closest thing to a restart
    // without tearing down the connection pool.
    const dir2 = mkdtempSync(join(tmpdir(), 'plur-pg-primary-2-'))
    try {
      const plur2 = new Plur({ path: dir2, store: adapter })
      const seen = await plur2.getById(written.id)
      expect(seen?.statement).toBe(marker)
      // And it is genuinely in the database, not a process-local cache.
      const rows = await adapter.load()
      expect(rows.map(r => r.id)).toContain(written.id)
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  }, TIMEOUT)

  it('a write is visible to a reader that never saw the writer', async () => {
    // The property a server deployment actually depends on: two processes,
    // one store. Modelled here as two adapters over the same schema, so the
    // only shared state is Postgres itself.
    const other = new PostgresAdapter({ connectionString: PG_URL!, schema: SCHEMA, vectorIndex: 'exact' })
    try {
      const e = await plur.learn('written by engine A, read by engine B', { scope: 'global' })
      const rows = await other.load()
      expect(rows.map(r => r.id)).toContain(e.id)
    } finally {
      await other.close().catch(() => { /* best effort */ })
    }
  }, TIMEOUT)

  it('fails loudly rather than skipping when the database is misconfigured', async () => {
    // Guards the gate itself. A suite that silently skips its own acceptance
    // test on a broken environment reports success for having done nothing.
    const bad = new PostgresAdapter({
      connectionString: PG_URL!.replace(/:[^:@]*@/, ':definitely-the-wrong-password@'),
      schema: SCHEMA,
      vectorIndex: 'exact',
    })
    await expect(bad.load()).rejects.toThrow()
    await bad.close().catch(() => { /* expected — never connected */ })
  }, TIMEOUT)
})
