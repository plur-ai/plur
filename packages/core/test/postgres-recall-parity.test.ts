/**
 * `recall()` on the Postgres tier must agree with the rest of the engine.
 *
 * The BM25 pushdown (#743) replaced `_filterEngrams()` with a direct
 * `adapter.searchBM25()` call and returned. The comment above it claimed the
 * adapter was "handed the SAME filter this method would have applied in
 * memory". It was not. `_filterEngrams` also applies:
 *
 *   - temporal validity (`valid_until` / `valid_from`)
 *   - `min_strength`
 *   - engrams merged in from `config.stores` (team / enterprise stores)
 *   - pack engrams
 *
 * None survive a `SELECT` against one table. So on the Postgres tier, `recall()`
 * returned engrams that had been explicitly withdrawn, ignored `min_strength`,
 * and stopped seeing the team store entirely — while `list()`, `recallHybrid()`
 * and `inject()` on the SAME instance still behaved correctly. Two reads of one
 * store disagreeing, with no error either way.
 *
 * The existing pushdown tests asserted scope, scopes and domain — exactly the
 * three filters that WERE forwarded — which is why a full green suite missed it.
 * These assert the ones that were not.
 *
 * Gated on PLUR_TEST_POSTGRES_URL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { PostgresAdapter } from '../src/storage-postgres.js'

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
const TIMEOUT = 180_000

describe.skipIf(!PG_URL)('recall() parity on the Postgres tier (#743 regression)', () => {
  let adapter: PostgresAdapter
  let plur: Plur
  let dir: string
  let schema: string

  beforeEach(async () => {
    schema = 'plur_parity_' + Math.random().toString(36).slice(2, 10)
    dir = mkdtempSync(join(tmpdir(), 'plur-parity-'))
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema, vectorIndex: 'exact' })
    await adapter.save([])
    plur = new Plur({ path: dir, store: adapter })
    await plur.ready()
  }, TIMEOUT)

  afterEach(async () => {
    await adapter?.dropSchema().catch(() => { /* best effort */ })
    await adapter?.close().catch(() => { /* best effort */ })
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, TIMEOUT)

  it('does not return an engram whose validity has expired', async () => {
    await plur.learn('deploy the billing service nightly', { scope: 'global' })
    const stale = await plur.learn('deploy via the OLD pipeline, since withdrawn', { scope: 'global' })

    const rows = await adapter.load()
    const target = rows.find(r => r.id === stale.id)!
    ;(target as { temporal?: Record<string, unknown> }).temporal = {
      ...(target.temporal ?? {}),
      valid_until: '2020-01-01',
    }
    await adapter.save(rows)

    const hits = await plur.recall('deploy')
    expect(hits.map(h => h.id), 'an engram withdrawn in 2020 was returned as current').not.toContain(stale.id)
  }, TIMEOUT)

  it('agrees with list() about which engrams are live', async () => {
    // The invariant behind the specific cases: two reads of one store must not
    // disagree about what is in it.
    await plur.learn('alpha deployment runbook', { scope: 'global' })
    const stale = await plur.learn('beta deployment runbook, withdrawn', { scope: 'global' })
    const rows = await adapter.load()
    const t = rows.find(r => r.id === stale.id)!
    ;(t as { temporal?: Record<string, unknown> }).temporal = { ...(t.temporal ?? {}), valid_until: '2020-01-01' }
    await adapter.save(rows)

    const recalled = new Set((await plur.recall('deployment runbook', { limit: 50 })).map(e => e.id))
    const listed = new Set((await plur.list()).map(e => e.id))
    for (const id of recalled) {
      expect(listed.has(id), `recall() returned ${id}, which list() excludes`).toBe(true)
    }
  }, TIMEOUT)

  it('honours min_strength', async () => {
    await plur.learn('deploy the billing service', { scope: 'global' })
    const weak = await plur.learn('deploy something barely remembered', { scope: 'global' })
    const rows = await adapter.load()
    const t = rows.find(r => r.id === weak.id)!
    ;(t as { activation: Record<string, unknown> }).activation = { ...t.activation, retrieval_strength: 0.01 }
    await adapter.save(rows)

    const hits = await plur.recall('deploy', { min_strength: 0.5 })
    expect(hits.map(h => h.id), 'min_strength was ignored').not.toContain(weak.id)
  }, TIMEOUT)

  it('still returns engrams from a secondary (team) store', async () => {
    // The one that would present as "recall is broken": on the Postgres tier
    // `plur_recall` stopped returning the team store, while `recallHybrid` on
    // the same instance still did.
    const teamDir = mkdtempSync(join(tmpdir(), 'plur-team-'))
    const teamYaml = join(teamDir, 'engrams.yaml')
    try {
      const team = new Plur({ path: teamDir })
      await team.ready()
      const shared = await team.learn('the kubernetes rollout is staged per region', { scope: 'group:acme/eng' })

      writeFileSync(
        join(dir, 'config.yaml'),
        yaml.dump({ stores: [{ scope: 'group:acme/eng', shared: true, path: teamYaml }] }, { noRefs: true }),
      )
      const withTeam = new Plur({ path: dir, store: adapter })
      await withTeam.ready()
      await withTeam.learn('the billing deploy is nightly', { scope: 'global' })

      const hits = await withTeam.recall('kubernetes rollout', { limit: 20 })
      expect(hits.map(h => h.id), 'the team store vanished from recall()').toContain(shared.id)
    } finally {
      rmSync(teamDir, { recursive: true, force: true })
    }
  }, TIMEOUT)

  it('applies limit AFTER the residual filters, not before', async () => {
    // A row removed by expiry must not consume a slot: asking for 2 live
    // engrams should return 2, even when expired ones rank above them.
    const live: string[] = []
    for (let i = 0; i < 2; i++) {
      live.push((await plur.learn(`deploy target live number ${i}`, { scope: 'global' })).id)
    }
    const dead: string[] = []
    for (let i = 0; i < 4; i++) {
      dead.push((await plur.learn(`deploy target expired number ${i}`, { scope: 'global' })).id)
    }
    const rows = await adapter.load()
    for (const r of rows) {
      if (dead.includes(r.id)) {
        ;(r as { temporal?: Record<string, unknown> }).temporal = { ...(r.temporal ?? {}), valid_until: '2020-01-01' }
      }
    }
    await adapter.save(rows)

    const hits = await plur.recall('deploy target', { limit: 2 })
    expect(hits.length, 'expired rows consumed result slots').toBe(2)
    expect(hits.every(h => live.includes(h.id))).toBe(true)
  }, TIMEOUT)
})
