/**
 * Formal-verification round 2 (spec/formal/PlurSpec/R2Persist.lean §2,
 * findings/r2-persist.md item 2, core-persistence#11): one store-shape rule and
 * one duplicate-id detector, for every reader.
 *
 *  - sync's `readEngramList` accepted a bare top-level array that the loader
 *    (`parseEngramFile`) and the backup gate refuse — sync would commit and push
 *    a store PLUR itself cannot load.
 *  - Postgres `save`/`updateMany` failed on a duplicate id inside one 500-row
 *    chunk ("cannot affect row a second time") but silently kept the LAST copy
 *    when the duplicates fell into different chunks — the outcome depended on
 *    where the chunk boundary fell.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { sync, SyncStoreUnreadableError } from '../src/sync.js'
import { parseEngramFile, EngramStoreUnreadableError } from '../src/engrams.js'
import * as engramsMod from '../src/engrams.js'
import { validateStore } from '../src/backup.js'
import { PostgresAdapter } from '../src/storage-postgres.js'
import type { Engram } from '../src/schemas/engram.js'
import { isolateGitConfig } from './helpers/git-isolation.js'

function mkEngram(id: string, statement: string): Engram {
  return {
    id,
    statement,
    type: 'behavioral',
    scope: 'global',
    domain: 'plur.test',
    status: 'active',
    tags: [],
    activation: { retrieval_strength: 1.0, storage_strength: 1.0, frequency: 0, last_accessed: '2026-09-26' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as unknown as Engram
}

const BARE = '- id: ENG-2026-09-26-001\n  statement: bare array\n'
const CANON = yaml.dump({ engrams: [mkEngram('ENG-2026-09-26-001', 'canonical')] })

describe('formal-r2-persist: one store-shape rule', () => {
  isolateGitConfig()
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-r2shape-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('the loader and the backup gate refuse a bare top-level array', () => {
    const p = join(dir, 'engrams.yaml')
    writeFileSync(p, BARE)
    expect(() => parseEngramFile(p, BARE, Buffer.byteLength(BARE))).toThrow(EngramStoreUnreadableError)
    expect(validateStore(p).ok).toBe(false)
  })

  it('sync refuses a bare top-level array too, and commits nothing', () => {
    writeFileSync(join(dir, 'engrams.yaml'), BARE)
    expect(() => sync(dir)).toThrow(SyncStoreUnreadableError)
  })

  it('sync accepts the canonical shape', () => {
    writeFileSync(join(dir, 'engrams.yaml'), CANON)
    expect(sync(dir).action).toBe('initialized')
  })

  it('one duplicate-id detector, first-occurrence order', () => {
    const detect = (engramsMod as any).duplicateEngramIds
    expect(typeof detect).toBe('function')
    expect(detect([{ id: 'A' }, { id: 'B' }, { id: 'A' }, { id: 'B' }, { id: 'C' }, {}])).toEqual(['A', 'B'])
  })
})

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
const SCHEMA = 'plur_formal_r2_shape'

describe.skipIf(!PG_URL)('formal-r2-persist: Postgres save with duplicate ids is chunk-independent (P1: both kept)', () => {
  let adapter: PostgresAdapter
  beforeAll(async () => {
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: SCHEMA, vectorIndex: 'exact' })
    await adapter.save([])
  }, 120_000)
  afterAll(async () => {
    await adapter?.dropSchema().catch(() => {})
    await adapter?.close().catch(() => {})
  }, 120_000)

  const statements = async () => (await adapter.load()).map(e => `${e.id}=${e.statement}`).sort()

  // Owner decision P1 (2026-09-27): `save` no longer refuses — it follows the
  // shared duplicate rule (later different copy renamed, both kept). These two
  // cases pinned the interim refusal; the chunk-independence they checked is
  // unchanged: the outcome is the same wherever the chunk boundary falls.
  it('duplicates in DIFFERENT chunks: both kept, later one renamed (was: silently last-wins)', async () => {
    await adapter.save([mkEngram('ENG-KEEP', 'before')])
    const list = [mkEngram('ENG-DUP', 'first copy')]
    for (let i = 0; i < 499; i++) list.push(mkEngram(`ENG-F-${i}`, 'filler'))
    list.push(mkEngram('ENG-DUP', 'second copy')) // index 500: the next chunk
    await adapter.save(list)
    const got = await statements()
    expect(got).toContain('ENG-DUP=first copy')
    expect(got.filter(x => x.endsWith('=second copy'))).toHaveLength(1)
    expect(got).toHaveLength(501)
  }, 120_000)

  it('duplicates in ONE chunk: the same outcome (was: "cannot affect row a second time")', async () => {
    await adapter.save([mkEngram('ENG-KEEP', 'before')])
    await adapter.save([mkEngram('ENG-DUP', 'a'), mkEngram('ENG-DUP', 'b')])
    const got = await statements()
    expect(got).toHaveLength(2)
    expect(got).toContain('ENG-DUP=a')
    expect(got.filter(x => x.endsWith('=b'))).toHaveLength(1)
  }, 120_000)

  it('updateMany: the same refusal', async () => {
    await adapter.save([mkEngram('ENG-KEEP', 'before')])
    await expect(adapter.updateMany([mkEngram('ENG-KEEP', 'a'), mkEngram('ENG-KEEP', 'b')])).rejects.toThrow(/duplicate id/i)
    expect(await statements()).toEqual(['ENG-KEEP=before'])
  }, 120_000)
})
