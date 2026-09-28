/**
 * Round-2 apply follow-ups (coordinator, owner principles, 2026-09-27):
 *
 * F1 — Decision A covers learnAsync's candidate step: the LLM/cosine decision
 *      may only NOOP/UPDATE/MERGE against rows the writer can persist. A
 *      candidate held in a pack, a readonly store or another scope's remote
 *      cache is dropped, and the write proceeds as ADD.
 * F2 — "Every removal is explicit and traced": a REMOTE updateEngram that
 *      retires a row reads the previous status first and appends
 *      `engram_retired` {via:'update', routed_to:'remote'} only on a real
 *      transition; an unreadable previous status is logged with
 *      `previous_status_unknown: true`, never dropped.
 * F3 — Dry-run parity on a delegating store: the importer's in-file map keys
 *      by (hash, scope) where learn() does not dedup across scopes, so two
 *      records of one file with the same statement in different scopes are
 *      predicted as two imports.
 *
 * No network: remote drivers are stubbed in memory.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { readHistoryForEngram } from '../src/history.js'
import { runImport } from '../src/importers/engine.js'
import type { Engram } from '../src/schemas/engram.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'plur-r2apply-f-')); dirs.push(d); return d }
afterEach(() => { vi.restoreAllMocks(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

async function rowLike(dir: string, statement: string, id: string, scope: string) {
  const seed = new Plur({ path: join(dir, 'seed-' + id) })
  const e = await seed.learn(statement, { scope: 'global' })
  return { ...(await seed.getById(e.id)), id, scope }
}

describe('F1: learnAsync never NOOPs/UPDATEs into a row the writer cannot persist', () => {
  it('an LLM NOOP naming a pack candidate becomes an ADD', async () => {
    const dir = tmp()
    const packDir = join(dir, 'packs', 'p1')
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: p1\nversion: 1.0.0\ndescription: t\nlicense: cc0-1.0\n---\n\n# p1\n')
    writeFileSync(join(packDir, 'engrams.yaml'), yaml.dump({ engrams: [
      await rowLike(dir, 'Keep pull requests small and focused', 'ENG-2026-09-26-010', 'project:mine'),
    ] }))
    const plur = new Plur({ path: dir })
    const packId = ((await (plur as any)._loadSecondaryAndPacks()) as any[]).find(r => r._pack === 'p1').id
    const llm = vi.fn(async () => `DECISION: NOOP\nTARGET: ${packId}\nREASON: same`)
    const res = await plur.learnAsync('Keep pull requests small and well focused', { scope: 'project:mine', llm })
    expect(res.decision).toBe('ADD')
    expect(res.engram.scope).toBe('project:mine')
    expect((res.engram as any)._pack).toBeUndefined()
    const rows = await (plur as any)._primaryStore.load()
    expect(rows.map((r: Engram) => r.statement)).toEqual(['Keep pull requests small and well focused'])
  })

  it('good case: an own primary candidate can still be a NOOP', async () => {
    const dir = tmp()
    const plur = new Plur({ path: dir })
    const own = await plur.learn('Keep pull requests small and focused', { scope: 'project:mine' })
    const llm = vi.fn(async () => `DECISION: NOOP\nTARGET: ${own.id}\nREASON: same`)
    const res = await plur.learnAsync('Keep pull requests small and well focused', { scope: 'project:mine', llm })
    expect(res.decision).toBe('NOOP')
  })
})

describe('F2: a remote update that retires is traced', () => {
  const URL_ = 'https://plur.example.com/sse'
  const SCOPE = 'group:acme/team'
  function setup(prev: Engram | null | 'throw') {
    const dir = tmp()
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores: [{ url: URL_, token: 't', scope: SCOPE, shared: true, readonly: false }], index: false }))
    const plur = new Plur({ path: dir })
    const fake = {
      getById: vi.fn(async () => { if (prev === 'throw') throw new Error('down'); return prev }),
      patch: vi.fn(async (id: string, u: Partial<Engram>) => ({ ...(prev && prev !== 'throw' ? prev : {}), id, ...u }) as Engram),
    }
    vi.spyOn(plur as any, '_getRemoteDriver').mockReturnValue(fake)
    return { plur, fake }
  }
  const base = (status: 'active' | 'retired') => ({ id: 'SRV-1', statement: 's', scope: SCOPE, status } as unknown as Engram)
  const events = (plur: Plur, id: string) => readHistoryForEngram(plur.getStorageRoot(), id).filter(e => e.event === 'engram_retired')

  it('active → retired: one event, via update, routed_to remote', async () => {
    const { plur } = setup(base('active'))
    expect(await plur.updateEngram({ ...base('active'), status: 'retired' })).toBe(true)
    const ev = events(plur, 'SRV-1')
    expect(ev).toHaveLength(1)
    expect(ev[0].data).toMatchObject({ via: 'update', routed_to: 'remote' })
    expect(ev[0].data.previous_status_unknown).toBeUndefined()
  })

  it('already retired: no event', async () => {
    const { plur } = setup(base('retired'))
    await plur.updateEngram({ ...base('retired'), statement: 'edited' })
    expect(events(plur, 'SRV-1')).toHaveLength(0)
  })

  it('previous status unreadable: logged with previous_status_unknown', async () => {
    const { plur } = setup('throw')
    await plur.updateEngram({ ...base('active'), status: 'retired' })
    const ev = events(plur, 'SRV-1')
    expect(ev).toHaveLength(1)
    expect(ev[0].data.previous_status_unknown).toBe(true)
  })

  it('no retire in the patch: no read, no event', async () => {
    const { plur, fake } = setup(base('active'))
    await plur.updateEngram({ ...base('active'), statement: 'edited' })
    expect(fake.getById).not.toHaveBeenCalled()
    expect(events(plur, 'SRV-1')).toHaveLength(0)
  })
})

class DelegatingStore {
  readonly kind = 'memory' as const
  readonly location = null
  rows: Engram[] = []
  async load() { return this.rows.map(e => structuredClone(e)) }
  async loadCached() { return this.load() }
  async save(es: Engram[]) { this.rows = es.map(e => structuredClone(e)) }
  invalidate() {}
  async append(e: Engram) { this.rows.push(structuredClone(e)) }
  async updateMany(es: Engram[]) {
    for (const e of es) {
      const i = this.rows.findIndex(r => r.id === e.id)
      if (i === -1) this.rows.push(structuredClone(e)); else this.rows[i] = structuredClone(e)
    }
  }
  async loadByIds(ids: string[]) { return this.rows.filter(e => ids.includes(e.id)).map(e => structuredClone(e)) }
  async findActiveByContentHash(h: string, s: string) {
    const x = this.rows.find(e => e.status === 'active' && (e as any).content_hash === h && e.scope === s)
    return x ? structuredClone(x) : null
  }
  async nextEngramId(p: string) {
    const n = this.rows.filter(e => e.id.startsWith(p)).length + 1
    return `${p}${String(n).padStart(3, '0')}`
  }
}

describe('F3: in-file duplicates across scopes, dry run vs real run', () => {
  const recs = [
    { statement: 'Tag every release', scope: 'project:a' },
    { statement: 'Tag every release', scope: 'project:b' },
    { statement: 'Tag every release', scope: 'project:b' },
  ]
  const actions = (r: any) => r.records.map((x: any) => x.action)
  const plurWith = (store?: DelegatingStore) => new Plur({ path: tmp(), ...(store ? { store } : {}), autoDiscover: false } as any)

  it('delegating store: two scopes → two imports in both modes', async () => {
    const real = await runImport(plurWith(new DelegatingStore()), recs, { from: 'generic' })
    const dry = await runImport(plurWith(new DelegatingStore()), recs, { from: 'generic', dryRun: true })
    expect(actions(real)).toEqual(['imported', 'imported', 'skipped'])
    expect(actions(dry)).toEqual(actions(real))
  })

  it('YAML store: still scope-blind (cross-scope recurrence) in both modes', async () => {
    const real = await runImport(plurWith(), recs, { from: 'generic' })
    const dry = await runImport(plurWith(), recs, { from: 'generic', dryRun: true })
    expect(actions(real)).toEqual(['imported', 'skipped', 'skipped'])
    expect(actions(dry)).toEqual(actions(real))
  })
})
