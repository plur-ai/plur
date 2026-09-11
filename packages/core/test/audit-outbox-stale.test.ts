/** Invariant: a network response cannot delete or resurrect newer local state. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { saveEngrams, loadEngrams } from '../src/engrams.js'
import { withAsyncLock } from '../src/store/async-lock.js'
import { EngramSchemaPassthrough } from '../src/schemas/engram.js'

let root: string
let store: string
let plur: Plur
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-outbox-stale-')); store = join(root, 'engrams.yaml')
  writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, stores: [{
    url: 'https://audit.example', token: 'test-only', scope: 'group:example/team', readonly: false,
  }] }))
  saveEngrams(store, [EngramSchemaPassthrough.parse({
    id: 'ENG-2026-09-08-001', type: 'behavioral', scope: 'group:example/team', status: 'active',
    visibility: 'public', statement: 'Original queued fact', structured_data: { _outbox: {
      target_scope: 'group:example/team', target_url: 'https://audit.example', queued_at: new Date().toISOString(),
      last_attempt: '', last_error: '', attempt_count: 0,
    } },
  })])
  plur = new Plur({ path: root, autoDiscover: false }); await plur.ready()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }) })

it.each(['lost response', 'failed receipt'])('retries the same durable request after %s and restart', async failure => {
  const accepted = new Map<string, string>()
  const keys: string[] = []
  const originalWrite = (plur as any)._writeOutboxIdMap.bind(plur)
  let receiptWrites = 0
  vi.spyOn(plur as any, '_writeOutboxIdMap').mockImplementation(entries => {
    if (++receiptWrites === 2 && failure === 'failed receipt') throw new Error('receipt disk failure')
    originalWrite(entries)
  })
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const key = new Headers(init?.headers).get('Idempotency-Key')!
    expect(key).toMatch(/^[a-zA-Z0-9_-]{16,128}$/)
    const journal = JSON.parse(readFileSync(plur.outboxIdMapPath(), 'utf8'))
    expect(journal['ENG-2026-09-08-001'].request_id).toBe(key)
    keys.push(key)
    if (!accepted.has(key)) accepted.set(key, `ENG-SERVER-${accepted.size + 1}`)
    if (keys.length === 1 && failure === 'lost response') throw new Error('response lost after commit')
    return new Response(JSON.stringify({ id: accepted.get(key) }), { status: 201 })
  })
  vi.stubGlobal('fetch', fetcher)
  expect((await plur.flushOutbox()).failed).toBe(1)
  expect(loadEngrams(store)).toHaveLength(1)
  const restarted = new Plur({ path: root, autoDiscover: false }); await restarted.ready()
  expect((await restarted.flushOutbox()).flushed).toBe(1)
  expect(keys).toHaveLength(2)
  expect(new Set(keys).size).toBe(1)
  expect(accepted.size).toBe(1)
  expect(loadEngrams(store)).toEqual([])
})

it('refuses to send if operation identity cannot be durably recorded', async () => {
  vi.spyOn(plur as any, '_writeOutboxIdMap').mockImplementation(() => { throw new Error('intent disk failure') })
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  expect((await plur.flushOutbox()).failed).toBe(1)
  expect(fetcher).not.toHaveBeenCalled()
  expect(loadEngrams(store)).toHaveLength(1)
})

it.each(['local counter', 'endpoint alias', 'default port', 'object key order'])('keeps write identity across a change to %s', async variant => {
  const keys: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    keys.push(new Headers(init.headers).get('Idempotency-Key')!)
    if (keys.length === 1) throw new Error('response lost after commit')
    return new Response(JSON.stringify({ id: 'ENG-SERVER-001' }), { status: 201 })
  }))
  if (variant === 'object key order') {
    const rows = loadEngrams(store); rows[0].measured_under = { model: 'small', hardware: 'cpu' }; saveEngrams(store, rows)
  }
  expect((await plur.flushOutbox()).failed).toBe(1)
  if (variant === 'local counter') {
    const rows = loadEngrams(store)
    rows[0].activation.frequency += 1
    saveEngrams(store, rows)
  } else if (variant === 'object key order') {
    const rows = loadEngrams(store); rows[0].measured_under = { hardware: 'cpu', model: 'small' }; saveEngrams(store, rows)
  } else {
    writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, stores: [{ url: variant === 'default port' ? 'https://AUDIT.example:443/sse/' : 'https://audit.example/sse', token: 'test-only', scope: 'group:example/team', readonly: false }] }))
  }
  const restarted = new Plur({ path: root, autoDiscover: false }); await restarted.ready()
  expect((await restarted.flushOutbox()).flushed).toBe(1)
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
})

it.each([undefined, 'a-source'])('keeps the exact request identity and body when a direct write with source %s falls back to the outbox', async source => {
  saveEngrams(store, [], { allowShrink: true })
  const keys: string[] = []
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    keys.push(new Headers(init.headers).get('Idempotency-Key')!)
    bodies.push(JSON.parse(init.body as string))
    if (keys.length === 1) throw new Error('response lost after commit')
    return new Response(JSON.stringify({ id: 'ENG-SERVER-001' }), { status: 201 })
  }))
  const queued = await plur.learnRouted('A direct routed operation', { scope: 'group:example/team', source,
    measured_under: { hardware: 'cpu' }, knowledge_anchors: [{ path: 'bench.json' }],
    attribution: { asserted_by: 'agent:audit' }, dual_coding: { example: 'A measured workload' },
  })
  expect(queued.structured_data?._outbox).toBeDefined()
  const restarted = new Plur({ path: root, autoDiscover: false }); await restarted.ready()
  expect((await restarted.flushOutbox()).flushed).toBe(1)
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
  expect(bodies[1]).toEqual(bodies[0])
})

it('reuses a remote move identity after response loss and process restart', async () => {
  const rows = loadEngrams(store)
  rows[0].scope = 'local'; delete rows[0].structured_data!._outbox
  saveEngrams(store, rows)
  const keys: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    keys.push(new Headers(init.headers).get('Idempotency-Key')!)
    if (keys.length === 1) throw new Error('response lost after commit')
    return new Response(JSON.stringify({ id: 'ENG-SERVER-001' }), { status: 201 })
  }))
  expect((await plur.rescope([rows[0].id], 'group:example/team')).success).toBe(false)
  expect(loadEngrams(store)[0].status).toBe('active')
  const restarted = new Plur({ path: root, autoDiscover: false }); await restarted.ready()
  expect((await restarted.rescope([rows[0].id], 'group:example/team')).success).toBe(true)
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
  expect(loadEngrams(store)[0].status).toBe('retired')
})

it.each(['success', 'failure'] as const)('preserves an edit made during %s', async outcome => {
  let started!: () => void
  const entered = new Promise<void>(r => { started = r })
  let finish!: () => void
  const held = new Promise<void>(r => { finish = r })
  vi.stubGlobal('fetch', vi.fn(async () => {
    started(); await held
    if (outcome === 'failure') throw new Error('test network failure')
    return new Response(JSON.stringify({ id: 'ENG-SERVER-001' }), { status: 201 })
  }))
  const flush = plur.flushOutbox(); await entered
  await withAsyncLock(store, async () => {
    const rows = loadEngrams(store)
    rows[0].statement = 'Newer fact that must survive'
    if (outcome === 'failure') {
      rows[0].status = 'retired'
      delete rows[0].structured_data!._outbox
    }
    saveEngrams(store, rows)
  })
  finish(); await flush
  const rows = loadEngrams(store)
  expect(rows).toHaveLength(1)
  expect(rows[0].statement).toBe('Newer fact that must survive')
  if (outcome === 'failure') expect(rows[0].structured_data?._outbox).toBeUndefined()
})

it('serializes flushes from separate instances sharing a store', async () => {
  const other = new Plur({ path: root, autoDiscover: false }); await other.ready()
  const fetcher = vi.fn(async () => {
    await new Promise(r => setTimeout(r, 20))
    return new Response(JSON.stringify({ id: 'ENG-SERVER-001' }), { status: 201 })
  })
  vi.stubGlobal('fetch', fetcher)
  const results = await Promise.all([plur.flushOutbox(), other.flushOutbox()])
  expect(results.reduce((n, r) => n + r.flushed, 0)).toBe(1)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(loadEngrams(store)).toEqual([])
})

it('reuses a durable receipt when cleanup failed after remote acknowledgement', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'ENG-SERVER-001' }), { status: 201 }))
  vi.stubGlobal('fetch', fetcher)
  vi.spyOn(plur as any, '_writeEngrams').mockRejectedValueOnce(new Error('injected local cleanup failure'))
  await expect(plur.flushOutbox()).rejects.toThrow('injected local cleanup failure')
  expect(loadEngrams(store)).toHaveLength(1)
  const restarted = new Plur({ path: root, autoDiscover: false }); await restarted.ready()
  expect((await restarted.flushOutbox()).flushed).toBe(1)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(loadEngrams(store)).toEqual([])
})

it('migrates legacy receipts before sending and preserves relationships after cache deletion', async () => {
  const oldId = 'ENG-LOCAL-OLD'
  const receipts = { [oldId]: { server_id: 'ENG-SERVER-OLD', url: 'https://audit.example', at: Date.now() } }
  mkdirSync(join(root, 'cache'), { recursive: true })
  writeFileSync(join(root, 'cache', 'outbox-id-map.json'), JSON.stringify(receipts))
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(JSON.parse(readFileSync(join(root, 'state', 'outbox-id-map.json'), 'utf8'))[oldId]).toEqual(receipts[oldId])
    if (init?.method !== 'POST') throw new Error('Must resolve legacy local ID from receipt')
    return new Response(JSON.stringify({ id: 'ENG-SERVER-001' }), { status: 201 })
  })
  vi.stubGlobal('fetch', fetcher)
  expect((await plur.flushOutbox()).flushed).toBe(1)
  rmSync(join(root, 'cache'), { recursive: true, force: true })
  const row = EngramSchemaPassthrough.parse({
    id: 'ENG-2026-09-08-002', type: 'behavioral', scope: 'group:example/team', status: 'active', visibility: 'public',
    statement: 'A later correction', relations: { supersedes: [oldId] },
    structured_data: { _outbox: { target_scope: 'group:example/team', target_url: 'https://audit.example', queued_at: new Date().toISOString(), last_attempt: '', last_error: '', attempt_count: 0 } },
  })
  saveEngrams(store, [row])
  const restarted = new Plur({ path: root, autoDiscover: false }); await restarted.ready()
  expect((await restarted.flushOutbox()).flushed).toBe(1)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).supersedes).toEqual(['ENG-SERVER-OLD'])
  expect(statSync(restarted.outboxIdMapPath()).mode & 0o777).toBe(0o600)
})

it.each(['{broken', '[]'])('refuses corrupt legacy receipt state before sending: %s', bytes => {
  mkdirSync(join(root, 'cache'), { recursive: true })
  writeFileSync(join(root, 'cache', 'outbox-id-map.json'), bytes)
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  return expect(plur.flushOutbox()).rejects.toThrow('durable outbox receipts').then(() => {
    expect(fetcher).not.toHaveBeenCalled()
    expect(loadEngrams(store)).toHaveLength(1)
    expect(readFileSync(join(root, 'cache', 'outbox-id-map.json'), 'utf8')).toBe(bytes)
  })
})

it('refuses a failed legacy promotion before sending and preserves both queued and legacy bytes', async () => {
  mkdirSync(join(root, 'cache'), { recursive: true })
  const legacy = join(root, 'cache', 'outbox-id-map.json')
  writeFileSync(legacy, '{}')
  vi.spyOn(plur as any, '_writeOutboxIdMap').mockImplementationOnce(() => { throw new Error('injected promotion failure') })
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(plur.flushOutbox()).rejects.toThrow('durable outbox receipts')
  expect(fetcher).not.toHaveBeenCalled()
  expect(readFileSync(legacy, 'utf8')).toBe('{}')
  expect(loadEngrams(store)).toHaveLength(1)
})

it('never falls back from corrupt authoritative receipts to a stale valid legacy cache', async () => {
  mkdirSync(join(root, 'cache'), { recursive: true })
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(join(root, 'cache', 'outbox-id-map.json'), '{}')
  writeFileSync(plur.outboxIdMapPath(), '{broken')
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(plur.flushOutbox()).rejects.toThrow('durable outbox receipts')
  expect(fetcher).not.toHaveBeenCalled()
  expect(loadEngrams(store)).toHaveLength(1)
})

it.each(['group:example/team', 'group:other/team', 'missing'])('validates canonical supersession targets in destination scope: %s', remoteScope => {
  return (async () => {
    const rows = loadEngrams(store)
    rows[0].relations = { ...rows[0].relations, supersedes: ['ENG-SERVER-OLD'] } as any
    saveEngrams(store, rows)
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'ENG-SERVER-001' }), { status: 201 })
      if (remoteScope === 'missing') return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ id: 'ENG-SERVER-OLD', scope: remoteScope, status: 'active', data: { statement: 'Existing remote fact' } }))
    })
    vi.stubGlobal('fetch', fetcher)
    const result = await plur.flushOutbox()
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(remoteScope === 'group:example/team' ? 1 : 0)
    expect(result.flushed).toBe(remoteScope === 'group:example/team' ? 1 : 0)
    if (remoteScope !== 'group:example/team') expect(loadEngrams(store)).toHaveLength(1)
  })()
})
