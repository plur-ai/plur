/**
 * Three ways `recall()` returned the wrong thing on a pushdown-capable store.
 *
 * All three are invisible from the caller's side: results come back, there is
 * no error, and the only symptom is that they are the wrong results or fewer of
 * them than the store holds.
 *
 * Gated on PLUR_TEST_POSTGRES_URL like the other Postgres suites.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { PostgresAdapter } from '../src/storage-postgres.js'
import type { Engram } from '../src/schemas/engram.js'

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
const TIMEOUT = 180_000
let counter = 0
const freshSchema = () => `plur_rq_${process.pid}_${counter++}`

function makeEngram(id: string, statement: string, over: Record<string, unknown> = {}): Engram {
  return {
    id, statement, type: 'behavioral', scope: 'global', status: 'active', visibility: 'private',
    version: 1, engram_version: 1, consolidated: false,
    reference_count: 0, recurrence_count: 0, episode_ids: [], sources: [], tags: [],
    relations: { broader: [], narrower: [], related: [], conflicts: [], supersedes: [], superseded_by: [] },
    activation: { retrieval_strength: 1, storage_strength: 1, last_accessed: null, decay_rate: 0 },
    temporal: { learned_at: '2026-07-28' },
    created_at: '2026-07-28T00:00:00Z', updated_at: '2026-07-28T00:00:00Z',
    ...over,
  } as unknown as Engram
}

describe.skipIf(!PG_URL)('recall() quality on a pushdown store', () => {
  let dir: string
  let storeDir: string
  let adapter: PostgresAdapter

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-rq-'))
    storeDir = mkdtempSync(join(tmpdir(), 'plur-rq-store-'))
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
  })

  afterEach(async () => {
    await adapter?.dropSchema().catch(() => { /* best effort */ })
    await adapter?.close().catch(() => { /* best effort */ })
    for (const d of [dir, storeDir]) if (d) rmSync(d, { recursive: true, force: true })
  }, TIMEOUT)

  it('a secondary-store engram can outrank primary hits', async () => {
    // The ordering bug. `[...narrowed, ...extra].slice(0, limit)` puts every
    // outsider after every primary row, so with a primary store holding `limit`
    // matches the best match in a team store never appears at all.
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: freshSchema(), vectorIndex: 'exact' })
    // Primary: weak matches — one query term each.
    await adapter.save(Array.from({ length: 10 }, (_, i) =>
      makeEngram(`ENG-2026-0728-1${String(i).padStart(2, '0')}`, `kubernetes note number ${i}`)))

    // Secondary store: the exact match for the whole query.
    const storePath = join(storeDir, 'team.yaml')
    writeFileSync(storePath, yaml.dump({
      engrams: [{
        ...makeEngram('ENG-2026-0728-900', 'kubernetes ingress autoscaling policy for the tenant cluster'),
        activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-07-28' },
        feedback_signals: { positive: 0, negative: 0, neutral: 0 }, associations: [], derivation_count: 1,
      }],
    }))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ path: storePath, scope: 'datafund', readonly: false }], index: false,
    }))

    const plur = new Plur({ path: dir, store: adapter })
    await plur.ready()

    const hits = await plur.recall('kubernetes ingress autoscaling policy tenant cluster', { limit: 5 })
    expect(
      hits.map(e => e.statement),
      'the best match lives in a secondary store and was appended after the primary page',
    ).toContain('kubernetes ingress autoscaling policy for the tenant cluster')
    // Inclusion alone has no teeth: a mutation that includes outsiders but
    // ranks them at a fixed low slot still lands them somewhere in the top 5
    // of this fixture. The secondary engram matches every query term while
    // each primary row matches one — it must be FIRST, not merely present
    // (#752, audit finding on this very test).
    expect(
      hits[0]?.statement,
      'ranked together means ranked correctly — the all-terms match must win, not just appear',
    ).toBe('kubernetes ingress autoscaling policy for the tenant cluster')
  }, TIMEOUT)

  it('a term common in a secondary store does not bury the best primary match', async () => {
    // The IDF direction of the union bug (#752). Outsiders used to be scored
    // with primary-only corpus statistics, so a query term ABSENT from the
    // primary corpus priced at df=0 → log(N/1): maximally rare, however
    // common it is in the store it lives in. Team jargon is exactly that
    // shape — common in the team store, absent from the personal one — and it
    // made every weak jargon row outrank a strong on-topic primary match
    // (measured: rank 197 of 297). Union statistics restore the order.
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: freshSchema(), vectorIndex: 'exact' })
    const primary: Engram[] = [
      makeEngram('ENG-2026-0728-400', 'widget widget widget widget widget'),
    ]
    for (let i = 0; i < 19; i++) {
      primary.push(makeEngram(`ENG-2026-0728-4${String(i + 10)}`, `widget filler note ${i}`))
    }
    for (let i = 0; i < 20; i++) {
      primary.push(makeEngram(`ENG-2026-0728-4${String(i + 40)}`, `plain filler note ${i}`))
    }
    await adapter.save(primary)

    const storePath = join(storeDir, 'team.yaml')
    writeFileSync(storePath, yaml.dump({
      engrams: Array.from({ length: 19 }, (_, i) => ({
        ...makeEngram(`ENG-2026-0728-8${String(i).padStart(2, '0')}`, `zephyr team note ${i}`),
        activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-07-28' },
        feedback_signals: { positive: 0, negative: 0, neutral: 0 }, associations: [], derivation_count: 1,
      })),
    }))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ path: storePath, scope: 'datafund', readonly: false }], index: false,
    }))

    const plur = new Plur({ path: dir, store: adapter })
    await plur.ready()

    const hits = await plur.recall('widget zephyr', { limit: 5 })
    expect(
      hits[0]?.statement,
      'the 5x on-topic primary match lost to a row whose only merit is a term the primary corpus has never seen',
    ).toBe('widget widget widget widget widget')
  }, TIMEOUT)

  it('returns a full page even when residual filters reject most of the corpus', async () => {
    // The starvation bug. A FIXED 3x over-fetch is only enough while expiry /
    // min_strength remove less than two thirds of the narrowed page.
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: freshSchema(), vectorIndex: 'exact' })
    const corpus: Engram[] = []
    // 60 weak engrams that the min_strength filter will reject...
    for (let i = 0; i < 60; i++) {
      corpus.push(makeEngram(`ENG-2026-0728-2${String(i).padStart(2, '0')}`, `deployment rollout note ${i}`, {
        activation: { retrieval_strength: 0.05, storage_strength: 1, last_accessed: null, decay_rate: 0 },
      }))
    }
    // ...and 5 strong ones it will keep.
    for (let i = 0; i < 5; i++) {
      corpus.push(makeEngram(`ENG-2026-0728-3${String(i).padStart(2, '0')}`, `deployment rollout keeper ${i}`, {
        activation: { retrieval_strength: 0.9, storage_strength: 1, last_accessed: null, decay_rate: 0 },
      }))
    }
    await adapter.save(corpus)

    const plur = new Plur({ path: dir, store: adapter })
    await plur.ready()

    const hits = await plur.recall('deployment rollout', { limit: 5, min_strength: 0.5 })
    expect(
      hits.length,
      'the store holds 5 qualifying rows but the fixed over-fetch returned fewer',
    ).toBe(5)
    expect(hits.every(e => e.activation.retrieval_strength >= 0.5)).toBe(true)
  }, TIMEOUT)

  it('a row missing a schema-defaulted field does not crash recall', async () => {
    // The parseRow bug. Every other read applies the schema (filling defaults);
    // the BM25 pushdown took `r.data` raw, so the scorer met an undefined
    // `activation` and the whole recall threw.
    const schema = freshSchema()
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema, vectorIndex: 'exact' })
    await adapter.save([makeEngram('ENG-2026-0728-400', 'postgres vacuum tuning for the write path')])

    // Write a row directly, the way a migration or an older build would: valid
    // JSON, but with `activation` absent.
    const pool = await (adapter as unknown as { getPool(): Promise<{ query: Function }> }).getPool()
    const bare = {
      id: 'ENG-2026-0728-401', statement: 'postgres vacuum tuning written without activation',
      type: 'behavioral', scope: 'global', status: 'active',
    }
    await pool.query(
      `UPDATE "${schema}".engrams SET data = $1 WHERE id = $2`,
      [JSON.stringify(bare), 'ENG-2026-0728-400'],
    )
    await pool.query(`UPDATE "${schema}".engrams SET id = $1 WHERE id = $2`,
      ['ENG-2026-0728-401', 'ENG-2026-0728-400'])

    const plur = new Plur({ path: dir, store: adapter })
    await plur.ready()

    // Must not throw.
    const hits = await plur.recall('postgres vacuum tuning', { limit: 5 })
    expect(Array.isArray(hits)).toBe(true)
    // And the defaulted field is present on the way out.
    for (const h of hits) expect(h.activation, 'schema defaults were not applied').toBeDefined()
  }, TIMEOUT)
})
