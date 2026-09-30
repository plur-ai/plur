/**
 * Audit of #1228 (persistence slice), finding 2: the duplicate-id rename (P1)
 * made loading a store a history scan per renamed id.
 *
 * `recordIdRenames` called `readHistoryForEngram` for every rename — each call
 * reads and parses every history/*.jsonl — and it ran from `loadEngrams`, a
 * READ path. The renames stay in the file until the next write, so every fresh
 * read-only process (hooks, CLI recall, the index sync) paid renames × whole
 * history: measured 250 s for 2000 engrams / 29 MB history / 300 duplicates,
 * against 137 ms on main.
 *
 * Now: a load records nothing (no history write from a read), the rename is
 * recorded when the renamed id is first WRITTEN (under the store lock), and
 * recording any number of renames is one history pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { loadEngrams, saveEngrams, recordIdRenames } from '../src/engrams.js'
import { listHistoryMonths, readHistory, appendHistory } from '../src/history.js'

const rekeyed = (root: string) =>
  listHistoryMonths(root).flatMap(m => readHistory(root, m)).filter(x => x.event === 'engram_rekeyed')

function raw(id: string, statement: string) {
  return { id, statement, type: 'behavioral', status: 'active', confidence: 0.5, created: '2026-09-01', scope: 'global' }
}

describe('audit #1228 finding 2: duplicate-id renames cost one history pass, and never from a read', () => {
  let root: string
  let file: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-audit-ren-'))
    mkdirSync(join(root, 'history'))
    writeFileSync(join(root, 'config.yaml'), '{}\n')
    file = join(root, 'engrams.yaml')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('a read-only load writes no history, however often it runs', () => {
    writeFileSync(file, yaml.dump({ engrams: [raw('ENG-X-1', 'first'), raw('ENG-X-1', 'second')] }))
    const before = statSync(join(root, 'history')).mtimeMs
    for (let i = 0; i < 3; i++) expect(loadEngrams(file)).toHaveLength(2)
    expect(rekeyed(root)).toHaveLength(0)
    expect(listHistoryMonths(root)).toEqual([])
    expect(statSync(join(root, 'history')).mtimeMs).toBe(before)
  })

  it('the rename is recorded once, by the write that puts the new id on disk', () => {
    writeFileSync(file, yaml.dump({ engrams: [raw('ENG-X-1', 'first'), raw('ENG-X-1', 'second')] }))
    const got = loadEngrams(file)
    const newId = got[1].id
    saveEngrams(file, got)
    const ev = rekeyed(root)
    expect(ev).toHaveLength(1)
    expect(ev[0].engram_id).toBe(newId)
    expect(ev[0].data).toMatchObject({ from: 'ENG-X-1', to: newId })
    expect(ev[0].reason).toMatch(/duplicate id/i)
    // The file no longer carries the clash: later loads and saves record nothing.
    saveEngrams(file, loadEngrams(file))
    expect(rekeyed(root)).toHaveLength(1)
  })

  it('a write that dropped the renamed engram records no rename for it', () => {
    writeFileSync(file, yaml.dump({ engrams: [raw('ENG-X-1', 'first'), raw('ENG-X-2', 'other'), raw('ENG-X-1', 'second')] }))
    const got = loadEngrams(file)
    saveEngrams(file, got.filter(e => e.statement !== 'second'), { allowShrink: true })
    expect(rekeyed(root)).toHaveLength(0)
  })

  it('recordIdRenames is idempotent against an existing log (another process already recorded it)', () => {
    appendHistory(root, { event: 'engram_rekeyed', engram_id: 'ENG-A-Dabc', timestamp: new Date().toISOString(), data: { from: 'ENG-A', to: 'ENG-A-Dabc' } })
    recordIdRenames(root, [{ from: 'ENG-A', to: 'ENG-A-Dabc' }, { from: 'ENG-B', to: 'ENG-B-Ddef' }], 'test')
    const ev = rekeyed(root)
    expect(ev.map(e => e.engram_id).sort()).toEqual(['ENG-A-Dabc', 'ENG-B-Ddef'])
  })

  it('perf: 2000 engrams, 300 duplicate ids, a large history — load and the first save stay fast', () => {
    const list = []
    for (let i = 0; i < 2000; i++) list.push(raw(`ENG-2026-09-01-${i}`, 'statement ' + i))
    for (let i = 0; i < 300; i++) list.push(raw(`ENG-2026-09-01-${i}`, 'other machine statement ' + i))
    writeFileSync(file, yaml.dump({ engrams: list }, { lineWidth: 120, noRefs: true }))
    // ~6 MB of unrelated history across six months.
    const line = JSON.stringify({ event: 'co_injection', engram_id: 'INJ-1', timestamp: '2026-08-01T00:00:00Z', data: { ids: Array.from({ length: 10 }, (_, i) => 'ENG-2026-09-01-' + i) } }) + '\n'
    for (const m of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
      writeFileSync(join(root, 'history', m + '.jsonl'), line.repeat(Math.ceil(1e6 / line.length)))
    }
    let t = performance.now()
    const got = loadEngrams(file)
    const loadMs = performance.now() - t
    expect(got).toHaveLength(2300)
    t = performance.now()
    saveEngrams(file, got)
    const saveMs = performance.now() - t
    expect(rekeyed(root)).toHaveLength(300)
    // Before the fix the load alone was 300 whole-history scans: 175 s for this
    // fixture on the audit machine. Idle, both now take well under a second; the
    // bound leaves room for a loaded parallel test run.
    expect(loadMs).toBeLessThan(15_000)
    expect(saveMs).toBeLessThan(15_000)
    expect(readFileSync(file, 'utf8')).not.toBe('')
  }, 60_000)
})
