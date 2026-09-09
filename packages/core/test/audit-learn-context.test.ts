import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Plur, computeContentHash } from '../src/index.js'
let root: string
let plur: Plur
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-context-preservation-'))
  writeFileSync(join(root, 'config.yaml'), 'index: false\ndedup:\n  mode: off\n')
  plur = new Plur({ path: root, autoDiscover: false }); await plur.ready()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }) })
it.each(['learn', 'learnRouted', 'learnAsync'] as const)('%s preserves distinct measurement contexts and deduplicates exact repeats', async method => {
  const write = async (hardware: string) => {
    const result = await plur[method]('Latency was measured as 18 milliseconds', { scope: 'local', measured_under: { hardware, dataset: 'synthetic' } })
    return method === 'learnAsync' ? (result as any).engram : result
  }
  const first = await write('cpu'); const second = await write('gpu'); const repeat = await write('gpu')
  expect(second.id).not.toBe(first.id)
  expect(repeat.id).toBe(second.id)
  const fresh = new Plur({ path: root, autoDiscover: false }); await fresh.ready()
  expect((await fresh.getById(first.id))?.measured_under?.hardware).toBe('cpu')
  expect((await fresh.getById(second.id))?.measured_under?.hardware).toBe('gpu')
})
it('does not broaden a differently conditioned assertion across scopes', async () => {
  const first = await plur.learn('A benchmark has a measured outcome', { scope: 'project:one', measured_under: { hardware: 'cpu' } })
  const second = await plur.learn('A benchmark has a measured outcome', { scope: 'project:two', measured_under: { hardware: 'gpu' } })
  expect(second.id).not.toBe(first.id)
  expect(second.scope).toBe('project:two')
  expect((await plur.getById(first.id))?.scope).toBe('project:one')
})
it('preserves changed licence and provenance content instead of absorbing it', async () => {
  const first = await plur.learn('A reusable attributed assertion', { license: 'MIT', source: 'source-one', scope: 'local' })
  const second = await plur.learn('A reusable attributed assertion', { license: 'Apache-2.0', source: 'source-two', scope: 'local' })
  expect(second.id).not.toBe(first.id)
  expect(second.provenance?.license).toBe('Apache-2.0')
  expect(second.source).toBe('source-two')
})

it('does not invent an explicit licence when source provenance is reloaded', async () => {
  const row = await plur.learn('An observation with a source but no chosen licence', { scope: 'local', source: 'source-note' })
  expect(row.provenance?.license).toBeUndefined()
  const fresh = new Plur({ path: root, autoDiscover: false }); await fresh.ready()
  expect((await fresh.getById(row.id))?.provenance?.license).toBeUndefined()
})

it('preserves the local original when its custom content has no remote representation', async () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, stores: [{ url: 'https://audit.invalid', scope: 'group:audit/team', token: 'fixture', readonly: false }] }))
  plur = new Plur({ path: root, autoDiscover: false }); await plur.ready()
  const row = await plur.learn('A qualified observation', { scope: 'local' })
  await plur.updateEngram({ ...row, structured_data: { qualification: 'Only after manual confirmation' } })
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ rows: [], total_count: 0 })))
  vi.stubGlobal('fetch', fetcher)
  const result = await plur.rescope(row.id, 'group:audit/team')
  expect(result.success).toBe(false)
  expect(result.results[0].status).toBe('error')
  const preserved = await plur.getById(row.id)
  expect(preserved?.status).toBe('active')
  expect(preserved?.scope).toBe('local')
  expect(preserved?.structured_data).toEqual({ qualification: 'Only after manual confirmation' })
  expect(fetcher.mock.calls.some(call => (call as any)[1]?.method === 'POST')).toBe(false)
})
it('keeps an explicitly private routed write on disk without contacting the remote', async () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, stores: [{ url: 'https://audit.invalid', scope: 'group:audit/team', token: 'fixture', readonly: false }] }))
  plur = new Plur({ path: root, autoDiscover: false }); await plur.ready()
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Response(JSON.stringify({ id: 'ENG-SERVER-PRIVATE', scope: 'group:audit/team', status: 'active', statement: 'Personal observation' }))
    : new Response(JSON.stringify({ rows: [], total_count: 0 })))
  vi.stubGlobal('fetch', fetcher)
  const result = await plur.learnRouted('Personal observation', { scope: 'group:audit/team', visibility: 'private' })
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  expect(await plur.getById(result.id)).not.toBeNull()
  expect(result.structured_data?._outbox).toBeUndefined()
})

it('transmits changed context to a remote and returns the server review decision', async () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, stores: [{ url: 'https://audit.invalid', scope: 'group:audit/team', token: 'fixture', readonly: false }] }))
  plur = new Plur({ path: root, autoDiscover: false }); await plur.ready()
  const rows: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const sent = JSON.parse(init.body as string)
      const row = { ...sent, id: `ENG-SERVER-${rows.length + 1}`, status: 'active', commitment: 'draft', review_state: 'policy', review_required: true }
      rows.push(row)
      return new Response(JSON.stringify(row), { status: 201 })
    }
    return new Response(JSON.stringify({ rows: rows.map(row => ({ id: row.id, scope: row.scope, status: row.status, data: row })), total_count: rows.length }))
  }))
  const first = await plur.learnRouted('Remote measured assertion', { scope: 'group:audit/team', measured_under: { hardware: 'cpu' } })
  const second = await plur.learnRouted('Remote measured assertion', { scope: 'group:audit/team', measured_under: { hardware: 'gpu' } })
  expect(second.id).not.toBe(first.id)
  expect(rows.map(row => row.measured_under.hardware)).toEqual(['cpu', 'gpu'])
  expect(first.commitment).toBe('draft')
  expect((first as any).review_required).toBe(true)
})

it.each(['learn', 'learnRouted', 'learnAsync'] as const)('%s preserves additional source references when a local duplicate is absorbed', async method => {
  const write = async (source: string) => {
    const result = await plur[method]('One fact from several sources', { scope: 'local', source })
    return method === 'learnAsync' ? (result as any).engram : result
  }
  const first = await write('source-one')
  const second = await write('source-two')
  expect(second.id).toBe(first.id)
  const fresh = new Plur({ path: root, autoDiscover: false }); await fresh.ready()
  expect((await fresh.getById(first.id))?.sources.map(source => source.source)).toEqual(['source-one', 'source-two'])
})
it('keeps distinct sources in separate pending remote writes', async () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, stores: [{ url: 'https://audit.invalid', scope: 'group:audit/team', token: 'fixture', readonly: false }] }))
  plur = new Plur({ path: root, autoDiscover: false }); await plur.ready()
  // Hold the background uploader; this test examines what is durable before delivery.
  vi.spyOn(plur as any, '_flushOutbox').mockResolvedValue({ flushed: 0, failed: 0, expired_warnings: [] })
  const first = await plur.learn('An assertion queued for sharing', { scope: 'group:audit/team', source: 'source-one' })
  const second = await plur.learn('An assertion queued for sharing', { scope: 'group:audit/team', source: 'source-two' })
  expect(second.id).not.toBe(first.id)
  expect(first.structured_data?._outbox).toBeDefined()
  expect(second.structured_data?._outbox).toBeDefined()
  expect((await plur.getById(first.id))?.source).toBe('source-one')
  expect((await plur.getById(second.id))?.source).toBe('source-two')
})

it.each(['learn', 'learnRouted', 'learnAsync'] as const)('%s cannot absorb an explicitly private write into a queued upload', async method => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, stores: [{ url: 'https://audit.invalid', scope: 'group:audit/team', token: 'fixture', readonly: false }] }))
  plur = new Plur({ path: root, autoDiscover: false }); await plur.ready()
  vi.spyOn(plur as any, '_flushOutbox').mockResolvedValue({ flushed: 0, failed: 0, expired_warnings: [] })
  const shared = await plur.learn('An assertion with separate private evidence', { scope: 'group:audit/team' })
  const result = await plur[method]('An assertion with separate private evidence', { scope: 'group:audit/team', visibility: 'private' })
  const personal = method === 'learnAsync' ? (result as any).engram : result
  expect(personal.id).not.toBe(shared.id)
  expect(personal.structured_data?._outbox).toBeUndefined()
  const fresh = new Plur({ path: root, autoDiscover: false }); await fresh.ready()
  const queued = await fresh.getById(shared.id)
  expect(queued?.structured_data?._outbox).toBeDefined()
  expect(queued?.write_count).toBe(shared.write_count)
  expect((await fresh.getById(personal.id))?.visibility).toBe('private')
})

it.each(['learn', 'learnRouted', 'learnAsync'] as const)('%s creates a local private copy when the remote already holds the statement', async method => {
  const scope = 'group:audit/team'
  const statement = 'A private observation also recorded elsewhere'
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, dedup: { mode: 'off' }, stores: [{ url: 'https://audit.invalid', scope, token: 'fixture', readonly: false }] }))
  const row = { id: 'ENG-REMOTE-PRIVATE', scope, status: 'active', statement, visibility: 'private', content_hash: computeContentHash(statement) }
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ rows: [{ ...row, data: row }], total_count: 1 })))
  vi.stubGlobal('fetch', fetcher)
  plur = new Plur({ path: root, autoDiscover: false }); await plur.ready()
  const result = await plur[method](statement, { scope, visibility: 'private' })
  const personal = method === 'learnAsync' ? (result as any).engram : result
  expect(personal.id).not.toContain('REMOTE')
  expect(personal.structured_data?._outbox).toBeUndefined()
  const rows = await (plur as any)._primaryStore.load()
  expect(rows.find((e: any) => e.id === personal.id)?.statement).toBe(statement)
})
