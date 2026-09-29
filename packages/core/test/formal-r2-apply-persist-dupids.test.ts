/**
 * Owner decision P1 (2026-09-27, spec/formal/decisions.resolved.yaml
 * `round2_rows.P1_duplicate_ids`, findings/r2-persist.md item 2):
 * "Keep both, rename one".
 *
 * Two different engrams carrying one id (two machines minting on the same day)
 * are both kept: the LATER copy gets a fresh id when a reader detects the
 * collision, and the rename is recorded in history. One rule for every reader —
 * the loader, the PGLite index, the Postgres writer, the backup gate. An exact
 * duplicate (the same record twice) is not a clash: one copy is kept.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { loadEngrams, saveEngrams, resolveDuplicateIds } from '../src/engrams.js'
import { readHistoryForEngram, listHistoryMonths, readHistory } from '../src/history.js'
import { validateStore } from '../src/backup.js'
import { PostgresAdapter } from '../src/storage-postgres.js'
import type { Engram } from '../src/schemas/engram.js'

function e(id: string, statement: string, scope = 'global'): Engram {
  return {
    id, statement, type: 'behavioral', scope, status: 'active', tags: [],
    activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-09-26' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as unknown as Engram
}

const ID_RE = /^(ENG|ABS|META)-[A-Za-z0-9-]+$/

function allEvents(root: string) {
  return listHistoryMonths(root).flatMap(m => readHistory(root, m))
}

describe('P1: the loader keeps both copies of a clashing id and renames the later one', () => {
  let root: string
  let file: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-p1-'))
    mkdirSync(join(root, 'history'))
    file = join(root, 'engrams.yaml')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('later copy gets a fresh, schema-valid id; both remain readable by their own ids', () => {
    writeFileSync(file, yaml.dump({ engrams: [
      e('ENG-2026-09-26-002', 'A local note'),
      e('ENG-2026-09-26-001', 'unrelated'),
      e('ENG-2026-09-26-002', 'B team fact'),
    ] }))
    const got = loadEngrams(file)
    expect(got).toHaveLength(3)
    const ids = got.map(x => x.id)
    expect(new Set(ids).size).toBe(3)
    expect(got[0]).toMatchObject({ id: 'ENG-2026-09-26-002', statement: 'A local note' })
    const renamed = got[2]
    expect(renamed.statement).toBe('B team fact')
    expect(renamed.id).not.toBe('ENG-2026-09-26-002')
    expect(renamed.id).toMatch(ID_RE)
    expect(renamed.id.startsWith('ENG-2026-09-26-002')).toBe(true)
  })

  it('the rename is recorded in history once, however many times the store is read', () => {
    writeFileSync(file, yaml.dump({ engrams: [e('ENG-X-1', 'first'), e('ENG-X-1', 'second')] }))
    const a = loadEngrams(file)
    const b = loadEngrams(file)
    // Deterministic: every reader and every load agree on the new id.
    expect(b.map(x => x.id)).toEqual(a.map(x => x.id))
    // Audit of #1228, finding 2: a load is a read and writes no history; the
    // write that puts the new id on disk records the rename, once.
    expect(allEvents(root).filter(x => x.event === 'engram_rekeyed')).toHaveLength(0)
    saveEngrams(file, b)
    loadEngrams(file)
    const newId = a[1].id
    const ev = readHistoryForEngram(root, newId).filter(x => x.event === 'engram_rekeyed')
    expect(ev).toHaveLength(1)
    expect(ev[0].data).toMatchObject({ from: 'ENG-X-1', to: newId })
    expect(ev[0].reason).toMatch(/duplicate id/i)
  })

  it('once saved, the rename is on disk and nothing is renamed again', () => {
    writeFileSync(file, yaml.dump({ engrams: [e('ENG-X-1', 'first'), e('ENG-X-1', 'second')] }))
    const a = loadEngrams(file)
    saveEngrams(file, a)
    const onDisk = (yaml.load(readFileSync(file, 'utf8')) as any).engrams.map((x: any) => x.id)
    expect(onDisk).toEqual(a.map(x => x.id))
    expect(loadEngrams(file).map(x => x.id)).toEqual(a.map(x => x.id))
    expect(allEvents(root).filter(x => x.event === 'engram_rekeyed')).toHaveLength(1)
  })

  it('an exact duplicate is not a clash: one copy is kept, and the save is not refused as a shrink', () => {
    const same = e('ENG-X-1', 'identical')
    writeFileSync(file, yaml.dump({ engrams: [same, same] }))
    const got = loadEngrams(file)
    expect(got).toHaveLength(1)
    expect(got[0].id).toBe('ENG-X-1')
    expect(allEvents(root).filter(x => x.event === 'engram_rekeyed')).toHaveLength(0)
    // 2 records on disk -> 1 written: a 50% "shrink" that is only the duplicate going.
    expect(() => saveEngrams(file, got)).not.toThrow()
    expect((yaml.load(readFileSync(file, 'utf8')) as any).engrams).toHaveLength(1)
  })

  it('three copies: every non-identical later copy gets its own id', () => {
    writeFileSync(file, yaml.dump({ engrams: [e('ENG-X-1', 'a'), e('ENG-X-1', 'b'), e('ENG-X-1', 'c'), e('ENG-X-1', 'b')] }))
    const got = loadEngrams(file)
    expect(got.map(x => x.statement)).toEqual(['a', 'b', 'c'])
    expect(new Set(got.map(x => x.id)).size).toBe(3)
  })

  it('a renamed id never collides with an id already in the store', () => {
    const first = [e('ENG-X-1', 'a'), e('ENG-X-1', 'b')]
    const planned = resolveDuplicateIds(first).engrams[1].id
    const got = resolveDuplicateIds([e('ENG-X-1', 'a'), e(planned, 'occupies the planned id'), e('ENG-X-1', 'b')]).engrams
    expect(new Set(got.map(x => x.id)).size).toBe(3)
  })
})

describe('P1: the backup gate follows the same rule', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plur-p1b-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('a store holding a clashing id is still a valid snapshot (the loader resolves it)', () => {
    const file = join(root, 'engrams.yaml')
    writeFileSync(file, yaml.dump({ engrams: [e('ENG-X-1', 'a'), e('ENG-X-2', 'z'), e('ENG-X-1', 'b')] }))
    const v = validateStore(file)
    expect(v.failures).not.toContain('duplicate-ids')
    expect(v.ok).toBe(true)
  })
})

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
const SCHEMA = 'plur_formal_r2_apply_p1'

describe.skipIf(!PG_URL)('P1: Postgres save keeps both copies under the same rule', () => {
  let adapter: PostgresAdapter
  beforeAll(async () => {
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: SCHEMA, vectorIndex: 'exact' })
    await adapter.save([])
  }, 120_000)
  afterAll(async () => {
    await adapter?.dropSchema().catch(() => {})
    await adapter?.close().catch(() => {})
  }, 120_000)

  it('duplicates across chunks: both rows land, the later one renamed', async () => {
    const list = [e('ENG-DUP', 'first copy')]
    for (let i = 0; i < 499; i++) list.push(e(`ENG-F-${i}`, 'filler'))
    list.push(e('ENG-DUP', 'second copy'))
    await adapter.save(list)
    const rows = await adapter.load()
    expect(rows).toHaveLength(501)
    const expected = resolveDuplicateIds(list).engrams[500].id
    expect(rows.find(r => r.id === 'ENG-DUP')?.statement).toBe('first copy')
    expect(rows.find(r => r.id === expected)?.statement).toBe('second copy')
  }, 120_000)

  it('duplicates in one chunk: the same outcome; an exact duplicate is kept once', async () => {
    await adapter.save([e('ENG-DUP', 'a'), e('ENG-DUP', 'b'), e('ENG-SAME', 's'), e('ENG-SAME', 's')])
    const rows = (await adapter.load()).map(r => r.statement).sort()
    expect(rows).toEqual(['a', 'b', 's'])
  }, 120_000)
})
