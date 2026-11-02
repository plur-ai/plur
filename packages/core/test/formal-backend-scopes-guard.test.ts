/**
 * Remote-only store guard and queue hold: the rules that had no test.
 * Model: spec/formal/PlurSpec/BackendScopes.lean (part B).
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { YamlPrimaryStore } from '../src/store/yaml-primary-store.js'
import { QueueHoldStore, RemoteOnlyStoreGuard } from '../src/store/remote-only-store-guard.js'
import type { Engram } from '../src/schemas/engram.js'

const FOLDER = '/work/client'
const TEAM = 'group:acme/eng'

function row(id: string, extra: Partial<Engram> = {}): Engram {
  return {
    id, statement: `s ${id}`, type: 'behavioral', scope: 'global', status: 'active', tags: [],
    activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-10-01' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    ...extra,
  } as Engram
}

function queued(id: string): Engram {
  return row(id, {
    scope: TEAM,
    structured_data: { _outbox: { remote_only: true, remote_only_folder: FOLDER, target_scope: TEAM } },
  } as Partial<Engram>)
}

/** An in-memory primary store with every optional member, plus query-adapter extras. */
function memStore(initial: Engram[]) {
  let rows = initial.map(e => structuredClone(e))
  return {
    kind: 'yaml', location: null,
    role: 'primary',
    get rows() { return rows },
    load: async () => rows.map(e => structuredClone(e)),
    loadCached: async () => rows.map(e => structuredClone(e)),
    invalidate: () => {},
    save: async (es: Engram[]) => { rows = es.map(e => structuredClone(e)) },
    append: async (e: Engram) => { rows.push(structuredClone(e)) },
    updateMany: async (es: Engram[]) => {
      for (const e of es) rows = rows.map(r => r.id === e.id ? structuredClone(e) : r)
    },
    loadByIds: async (ids: string[]) => rows.filter(r => ids.includes(r.id)).map(e => structuredClone(e)),
    searchBM25: async () => ['bm25'],
    corpusStats: async () => ({ n: rows.length }),
    someLaterCapability() { return this },
  }
}

describe('QueueHoldStore', () => {
  it('the remembered hold state does not share objects with a returned row', async () => {
    const inner = memStore([queued('Q1')])
    const hold = new QueueHoldStore(inner as any, s => s === TEAM)
    const [r] = await hold.load()
    // A caller edits the row it read in place, then writes it back.
    r.scope = 'global'
    ;(r.structured_data as any)._outbox.remote_only = false
    delete (r.structured_data as any)._outbox.remote_only_folder
    await expect(hold.save([r])).rejects.toThrow(/queue/i)
    expect(inner.rows[0].scope).toBe(TEAM)
  })

  it('a row read without the queue marker cannot gain a malformed one', async () => {
    const inner = memStore([row('P1')])
    const hold = new QueueHoldStore(inner as any, s => s === TEAM)
    const [r] = await hold.load()
    const marked = { ...r, structured_data: { _outbox: { remote_only: true, remote_only_folder: FOLDER, target_scope: TEAM } } } as Engram
    // scope 'global' differs from target_scope: not a well-formed queued save.
    await expect(hold.updateMany!([marked])).rejects.toThrow(/well-formed/)
    await expect(hold.save([marked])).rejects.toThrow(/well-formed/)
    expect(inner.rows[0].structured_data).toBeUndefined()
    // Through the hold check, a well-formed marker is accepted.
    await hold.updateMany!([{ ...marked, scope: TEAM }])
    expect(inner.rows[0].scope).toBe(TEAM)
  })

  it('a row queued by another writer after a whole-corpus read is still held when written unmarked', async () => {
    const inner = memStore([row('P1')])
    const hold = new QueueHoldStore(inner as any, s => s === TEAM)
    await hold.load()
    // Another instance queues X after that read; the caller gets X some other way.
    inner.rows.push(structuredClone(queued('X')))
    const stripped = row('X', { scope: 'global' })
    await expect(hold.updateMany!([stripped])).rejects.toThrow(/queue/i)
    await expect(hold.append!(stripped)).rejects.toThrow(/queue/i)
    await expect(hold.save([row('P1'), stripped])).rejects.toThrow(/queue/i)
    expect(inner.rows.find(r => r.id === 'X')!.scope).toBe(TEAM)
  })

  it('on a YAML store (no loadByIds), a row another writer queued after a whole-corpus read is still held', async () => {
    // Full rows: the YAML store drops rows that fail the engram schema.
    const full = (e: Engram): Engram => ({
      version: 2, consolidated: false, visibility: 'private',
      knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
      knowledge_anchors: [], associations: [], derivation_count: 1, pack: null, abstract: null,
      derived_from: null, polarity: null, content_hash: e.id, commitment: 'leaning', write_count: 1,
      sources: [], recurrence_count: 0, summary: '', engram_version: 1, episode_ids: [],
      ...e,
    } as Engram)
    const dir = mkdtempSync(join(tmpdir(), 'plur-hold-yaml-'))
    try {
      const file = join(dir, 'engrams.yaml')
      const mine = new YamlPrimaryStore(file)
      await mine.save([full(row('ENG-P1'))])
      const hold = new QueueHoldStore(mine as any, s => s === TEAM)
      await hold.load()
      await hold.loadCached()
      // A second instance on the same file queues X after that read.
      const other = new YamlPrimaryStore(file)
      await other.save([...(await other.load()), full(queued('ENG-X'))])
      expect((await other.load()).map(r => r.id)).toEqual(['ENG-P1', 'ENG-X'])
      const stripped = full(row('ENG-X', { scope: 'global' }))
      await expect(hold.save([full(row('ENG-P1')), stripped])).rejects.toThrow(/queue/i)
      expect((await other.load()).find(r => r.id === 'ENG-X')!.scope).toBe(TEAM)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forwards every non-write member of the inner store, bound to it, and wraps the three writes', async () => {
    const inner = memStore([row('P1')])
    const hold = new QueueHoldStore(inner as any, () => true) as any
    expect(hold.role).toBe('primary')
    expect(await hold.searchBM25()).toEqual(['bm25'])
    expect(await hold.corpusStats()).toEqual({ n: 1 })
    expect(hold.someLaterCapability()).toBe(inner)
    expect(hold.invalidate).toBeTypeOf('function')
    for (const w of ['save', 'append', 'updateMany']) {
      expect(hold[w]).toBeTypeOf('function')
      expect(hold[w]).not.toBe((inner as any)[w])
    }
    expect(hold.loadByIds).not.toBe(inner.loadByIds)
    expect((await hold.loadByIds(['P1'])).map((e: Engram) => e.id)).toEqual(['P1'])
  })
})

describe('RemoteOnlyStoreGuard', () => {
  it('allIds lists every id, hidden rows included, and nothing else', async () => {
    const inner = memStore([row('P1', { statement: 'PERSONAL SECRET' }), queued('Q1')])
    const guard = new RemoteOnlyStoreGuard(inner as any, { folder: FOLDER, scope: TEAM }, true, s => s === TEAM)
    const ids = await guard.allIds()
    expect(ids).toEqual(['P1', 'Q1'])
    expect(ids.every(i => typeof i === 'string')).toBe(true)
    expect(JSON.stringify(ids)).not.toContain('SECRET')
    expect((await guard.load()).map(e => e.id)).toEqual(['Q1'])
  })

  it('a whole-corpus save keeps every hidden row in place and refuses to touch one', async () => {
    const inner = memStore([row('P1'), queued('Q1'), row('P2')])
    const guard = new RemoteOnlyStoreGuard(inner as any, { folder: FOLDER, scope: TEAM }, true, s => s === TEAM)
    await guard.save([queued('Q2')])
    expect(inner.rows.map(e => e.id)).toEqual(['P1', 'P2', 'Q2'])
    await expect(guard.save([row('P1', { statement: 'overwritten' })])).rejects.toThrow()
    await expect(guard.updateMany!([row('P2', { statement: 'overwritten' })])).rejects.toThrow()
    await expect(guard.append!(row('P3'))).rejects.toThrow()
    expect(inner.rows.map(e => e.statement)).toEqual(['s P1', 's P2', 's Q2'])
  })

  it('a blocked binding refuses even a well-formed queued save', async () => {
    const inner = memStore([])
    const guard = new RemoteOnlyStoreGuard(inner as any, { folder: FOLDER, scope: TEAM, blocked: 'unreadable' }, true, () => true)
    await expect(guard.append!(queued('Q1'))).rejects.toThrow()
    await expect(guard.save([queued('Q1')])).rejects.toThrow()
    expect(inner.rows).toEqual([])
  })
})
