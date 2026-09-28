/**
 * Decision A (owner, 2026-09-27) — "Always store my write".
 *
 * When a write's statement already exists only where the writer cannot persist
 * it — an installed pack, a readonly store, another scope's remote cache — the
 * write is stored as a NEW row in the requested scope (normal learn path) and
 * the recurrence is recorded against the hit in history only. The pack /
 * readonly / remote row is never mutated and never absorbs the write.
 * Same-scope dedup against the writer's own persistable rows and #176
 * recurrence for local scopes are unchanged (good cases below).
 *
 * Model: spec/formal/PlurSpec/R2CoreA.lean §5 (`every_write_durable`,
 * `foreign_hit_untouched`). No network: remote caches are seeded in memory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { readHistoryForEngram } from '../src/history.js'

const S = 'Prefer small pull requests over large ones'

describe('Decision A: a write whose statement exists only where the writer cannot persist is stored', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-r2apply-a-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function rowLike(statement: string, id: string, scope: string) {
    const seed = new Plur({ path: join(dir, 'seed-' + id) })
    const e = await seed.learn(statement, { scope: 'global' })
    return { ...(await seed.getById(e.id)), id, scope }
  }

  function installPack(name: string, rows: unknown[]) {
    const packDir = join(dir, 'packs', name)
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, 'SKILL.md'), `---\nname: ${name}\nversion: 1.0.0\ndescription: t\nlicense: cc0-1.0\n---\n\n# ${name}\n`)
    writeFileSync(join(packDir, 'engrams.yaml'), yaml.dump({ engrams: rows }))
    return join(packDir, 'engrams.yaml')
  }

  const primaryRows = (plur: Plur) => (plur as any)._primaryStore.load() as Promise<any[]>
  const recurrenceEvents = (plur: Plur, id: string) =>
    readHistoryForEngram(plur.getStorageRoot(), id).filter(e => e.event === 'recurrence_detected')

  it('pack hit in ANOTHER scope: new row in the requested scope, pack row untouched, history only', async () => {
    const packFile = installPack('p1', [await rowLike(S, 'ENG-2026-09-26-001', 'group:packs/x')])
    const before = readFileSync(packFile, 'utf8')
    const plur = new Plur({ path: dir })
    const got = await plur.learn(S, { scope: 'project:mine' })
    expect((got as any)._pack).toBeUndefined()
    expect(got.scope).toBe('project:mine')
    expect(got.write_count ?? 1).toBe(1)
    const rows = await primaryRows(plur)
    expect(rows.map(r => r.statement)).toEqual([S])
    expect(readFileSync(packFile, 'utf8')).toBe(before)
    const ev = recurrenceEvents(plur, 'ENG-2026-09-26-001')
    expect(ev).toHaveLength(1)
    expect(ev[0].data.persisted_to).toBe('history-only')
    expect(ev[0].data.stored_as).toBe(got.id)
    expect(ev[0].data.from_scope).toBe('project:mine')
  })

  it('pack hit in the SAME scope: still a new row (a pack row is not the writer\'s own)', async () => {
    installPack('p2', [await rowLike(S, 'ENG-2026-09-26-002', 'project:mine')])
    const plur = new Plur({ path: dir })
    const got = await plur.learn(S, { scope: 'project:mine' })
    expect((got as any)._pack).toBeUndefined()
    expect((await primaryRows(plur)).map(r => r.statement)).toEqual([S])
    // The pack row was not mutated in memory either.
    const packRow = (await (plur as any)._loadSecondaryAndPacks()).find((r: any) => r._pack === 'p2')
    expect(packRow.write_count ?? 1).toBe(1)
    expect(recurrenceEvents(plur, 'ENG-2026-09-26-002')[0]?.data.persisted_to).toBe('history-only')
  })

  it('readonly store hit: new row; the readonly file is never written', async () => {
    const roPath = join(dir, 'ro.yaml')
    writeFileSync(roPath, yaml.dump({ engrams: [await rowLike(S, 'ENG-2026-09-26-003', 'project:ro')] }))
    const before = readFileSync(roPath, 'utf8')
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores: [{ path: roPath, scope: 'project:ro', readonly: true }], index: false }))
    const plur = new Plur({ path: dir })
    const got = await plur.learn(S, { scope: 'project:b' })
    expect(got.scope).toBe('project:b')
    expect((got as any).recurrence_count ?? 0).toBe(0)
    expect((await primaryRows(plur)).map(r => r.statement)).toEqual([S])
    expect(readFileSync(roPath, 'utf8')).toBe(before)
  })

  it('another scope\'s remote cache hit: new row, the cached row is not mutated', async () => {
    const URL_ = 'https://plur.example.com/sse'
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: URL_, token: 't', scope: 'group:acme/team', shared: true, readonly: false }], index: false,
    }))
    const plur = new Plur({ path: dir })
    const cachedRow = await rowLike(S, 'ENG-2026-09-26-004', 'group:acme/team')
    ;(plur as any)._getRemoteDriver({ url: URL_, token: 't', scope: 'group:acme/team' }).cache = { ts: Date.now(), engrams: [cachedRow] }
    const got = await plur.learn(S, { scope: 'project:mine' })
    expect(got.scope).toBe('project:mine')
    expect((await primaryRows(plur)).map(r => r.statement)).toEqual([S])
    expect(cachedRow.write_count ?? 1).toBe(1)
    expect((cachedRow as any).recurrence_count ?? 0).toBe(0)
  })

  it('wouldDeduplicate agrees: a pack-only hit predicts a new row (null)', async () => {
    installPack('p3', [await rowLike(S, 'ENG-2026-09-26-005', 'project:mine')])
    const plur = new Plur({ path: dir })
    expect(await plur.wouldDeduplicate(S, { scope: 'project:mine' })).toBeNull()
    expect(await plur.wouldDeduplicate(S, { scope: 'project:other' })).toBeNull()
  })

  it('learnAsync: a pack hit is not a NOOP', async () => {
    installPack('p4', [await rowLike(S, 'ENG-2026-09-26-006', 'project:mine')])
    const plur = new Plur({ path: dir })
    const res = await plur.learnAsync(S, { scope: 'project:mine' })
    expect(res.decision).not.toBe('NOOP')
    expect((await primaryRows(plur)).map(r => r.statement)).toEqual([S])
  })

  it('good case: a persistable own row still absorbs (same-scope #107 and cross-scope #176)', async () => {
    installPack('p5', [await rowLike(S, 'ENG-2026-09-26-007', 'project:a')])
    const plur = new Plur({ path: dir })
    const first = await plur.learn(S, { scope: 'project:a' })   // pack-only hit → new primary row
    const again = await plur.learn(S, { scope: 'project:a' })   // own primary row → dedup
    expect(again.id).toBe(first.id)
    expect(again.write_count).toBe(2)
    const cross = await plur.learn(S, { scope: 'project:b' })   // own primary row, other scope → #176
    expect(cross.id).toBe(first.id)
    expect((cross as any).recurrence_count).toBe(1)
    expect((await primaryRows(plur))).toHaveLength(1)
  })
})
