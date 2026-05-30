/**
 * Integration tests for RemoteStore against a real HTTP server.
 *
 * Unlike remote-routing.test.ts (which mocks globalThis.fetch), these tests
 * use a lightweight in-process stub server that speaks real HTTP over TCP.
 * This catches wire-level bugs: serialization, URL encoding, headers, status
 * codes, and the actual fetch() code path in RemoteStore.
 *
 * ## What this covers (from the test plan)
 *
 * - RemoteStore CRUD operations over real HTTP
 * - Plur learn() → remote routing with real network
 * - Read merging (local + remote via real HTTP)
 * - Auth rejection (401 on bad token)
 * - ID roundtrip (server-assigned IDs work end-to-end)
 *
 * ## What this does NOT cover
 *
 * - MCP layer (that's issue #82)
 * - Production smoke (that's issue #83)
 * - Full enterprise server with Postgres/auth/permissions (plur-ai/enterprise repo)
 *
 * See: https://github.com/plur-ai/plur/issues/81
 * Test plan: 3-plur/1-tracks/engineering/remote-store-test-plan.md
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { RemoteStore } from '../src/store/remote-store.js'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'integration-test-token'
let server: StubServer
let baseUrl: string

// Iter-2 audit M-3: production default backend flipped to 'pglite'. These
// remote-integration tests are about HTTP/wire behavior, not local indexing,
// so pin PLUR_BACKEND=sqlite to keep PGLite out of the way and avoid the
// WASM startup races that make the test suite flaky under heavy parallelism.
const originalBackend = process.env.PLUR_BACKEND
process.env.PLUR_BACKEND = 'sqlite'

beforeAll(async () => {
  server = new StubServer(TOKEN)
  const info = await server.start()
  baseUrl = info.url
})

afterAll(async () => {
  await server.stop()
  if (originalBackend === undefined) delete process.env.PLUR_BACKEND
  else process.env.PLUR_BACKEND = originalBackend
})

beforeEach(() => {
  server.reset()
  // Defensive: re-pin sqlite in case another test polluted the env var.
  process.env.PLUR_BACKEND = 'sqlite'
})

// ---------------------------------------------------------------------------
// RemoteStore direct — real HTTP, no Plur wrapper
// ---------------------------------------------------------------------------

describe('RemoteStore against stub server', () => {
  it('append creates engram, load returns it', async () => {
    const store = new RemoteStore(baseUrl, TOKEN, 'group:test', { ttlMs: 0 })
    await store.append({ id: 'tmp', scope: 'group:test', status: 'active', statement: 'hello world' } as any)

    expect(server.engramCount).toBe(1)

    const all = await store.load()
    expect(all.length).toBe(1)
    expect(all[0].id).toBe('ENG-SRV-001')
    expect((all[0] as any).statement).toBe('hello world')
  })

  it('getById returns engram or null', async () => {
    const store = new RemoteStore(baseUrl, TOKEN, 'group:test')
    await store.append({ id: 'tmp', scope: 'group:test', status: 'active', statement: 'findable' } as any)

    const found = await store.getById('ENG-SRV-001')
    expect(found).not.toBeNull()
    expect(found!.id).toBe('ENG-SRV-001')

    const missing = await store.getById('ENG-NONEXISTENT')
    expect(missing).toBeNull()
  })

  it('remove retires engram on server', async () => {
    const store = new RemoteStore(baseUrl, TOKEN, 'group:test')
    await store.append({ id: 'tmp', scope: 'group:test', status: 'active', statement: 'to remove' } as any)

    const removed = await store.remove('ENG-SRV-001')
    expect(removed).toBe(true)

    const onServer = server.getEngram('ENG-SRV-001')
    expect(onServer?.status).toBe('retired')
  })

  it('remove returns false for non-existent ID', async () => {
    const store = new RemoteStore(baseUrl, TOKEN, 'group:test')
    const removed = await store.remove('ENG-NONEXISTENT')
    expect(removed).toBe(false)
  })

  it('count reflects changes', async () => {
    const store = new RemoteStore(baseUrl, TOKEN, 'group:test', { ttlMs: 0 })
    expect(await store.count()).toBe(0)

    await store.append({ id: 'tmp', scope: 'group:test', status: 'active', statement: 'one' } as any)
    await store.append({ id: 'tmp', scope: 'group:test', status: 'active', statement: 'two' } as any)
    expect(await store.count()).toBe(2)
  })

  it('returns 401 on bad token', async () => {
    const badStore = new RemoteStore(baseUrl, 'wrong-token', 'group:test')
    const all = await badStore.load()
    // RemoteStore.load() catches errors and returns [] on non-ok responses
    expect(all).toEqual([])
  })

  it('append throws on bad token', async () => {
    const badStore = new RemoteStore(baseUrl, 'wrong-token', 'group:test')
    await expect(badStore.append({ id: 'x', scope: 'group:test', status: 'active' } as any))
      .rejects.toThrow('Remote store append failed: 401')
  })

  it('scope filtering returns only matching engrams', async () => {
    const store = new RemoteStore(baseUrl, TOKEN, 'group:alpha', { ttlMs: 0 })
    await store.append({ id: 'tmp', scope: 'group:alpha', status: 'active', statement: 'alpha-1' } as any)

    // Create an engram in a different scope via a second store
    const store2 = new RemoteStore(baseUrl, TOKEN, 'group:beta', { ttlMs: 0 })
    await store2.append({ id: 'tmp', scope: 'group:beta', status: 'active', statement: 'beta-1' } as any)

    const alphaEngrams = await store.load()
    expect(alphaEngrams.length).toBe(1)
    expect((alphaEngrams[0] as any).statement).toBe('alpha-1')

    const betaEngrams = await store2.load()
    expect(betaEngrams.length).toBe(1)
    expect((betaEngrams[0] as any).statement).toBe('beta-1')
  })

  it('server assigns unique IDs', async () => {
    const store = new RemoteStore(baseUrl, TOKEN, 'group:test', { ttlMs: 0 })
    await store.append({ id: 'tmp1', scope: 'group:test', status: 'active', statement: 'first' } as any)
    await store.append({ id: 'tmp2', scope: 'group:test', status: 'active', statement: 'second' } as any)

    const all = await store.load()
    expect(all[0].id).not.toBe(all[1].id)
    expect(all[0].id).toMatch(/^ENG-SRV-/)
    expect(all[1].id).toMatch(/^ENG-SRV-/)
  })
})

// ---------------------------------------------------------------------------
// Plur integration — real learn() → RemoteStore → stub server
// ---------------------------------------------------------------------------

describe('Plur integration with stub server', () => {
  let primaryDir: string

  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'plur-integ-'))
    server.reset()
    writeFileSync(
      join(primaryDir, 'config.yaml'),
      yaml.dump({
        stores: [{
          url: baseUrl,
          token: TOKEN,
          scope: 'group:test',
          shared: true,
          readonly: false,
        }],
        index: false,
      }, { lineWidth: 120, noRefs: true }),
    )
  })

  afterAll(() => {
    if (primaryDir && existsSync(primaryDir)) rmSync(primaryDir, { recursive: true, force: true })
  })

  it('learn routes to stub server, skips local', async () => {
    const plur = new Plur({ path: primaryDir })
    const engram = plur.learn('integration test engram', {
      scope: 'group:test',
      type: 'behavioral',
    })

    expect(engram.scope).toBe('group:test')

    // Wait for background append
    await new Promise(r => setTimeout(r, 50))

    // Server should have the engram
    expect(server.engramCount).toBe(1)

    // Local YAML should NOT have it
    const localYaml = join(primaryDir, 'engrams.yaml')
    if (existsSync(localYaml)) {
      const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams?: any[] } | null
      const found = (local?.engrams ?? []).find((e: any) => e.statement === 'integration test engram')
      expect(found).toBeUndefined()
    }
  })

  it('learn with unmatched scope writes locally', () => {
    const plur = new Plur({ path: primaryDir })
    plur.learn('local only engram', {
      scope: 'global',
      type: 'behavioral',
    })

    // Server should NOT have it
    expect(server.engramCount).toBe(0)

    // Local should have it
    const localYaml = join(primaryDir, 'engrams.yaml')
    expect(existsSync(localYaml)).toBe(true)
    const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams: any[] }
    expect(local.engrams.find(e => e.statement === 'local only engram')).toBeTruthy()
  })

  it('learn to remote lands on server, local recall still works', async () => {
    const plur = new Plur({ path: primaryDir })

    // Write one locally
    plur.learn('local knowledge about databases', { scope: 'global', type: 'procedural' })

    // Write one to remote
    plur.learn('remote team knowledge about deployment', { scope: 'group:test', type: 'procedural' })
    await new Promise(r => setTimeout(r, 50))

    // Server has the remote engram
    expect(server.engramCount).toBe(1)
    const srvEngram = server.getEngram('ENG-SRV-001')
    expect((srvEngram?.data as any)?.statement).toBe('remote team knowledge about deployment')

    // Local recall finds the local engram (remote merging requires
    // full engram schema from stub — tested via RemoteStore directly above)
    const results = plur.recall('databases')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].statement).toContain('databases')
  })

  it('readonly remote store blocks learn routing', async () => {
    // Reconfigure with readonly
    writeFileSync(
      join(primaryDir, 'config.yaml'),
      yaml.dump({
        stores: [{
          url: baseUrl,
          token: TOKEN,
          scope: 'group:test',
          shared: true,
          readonly: true,
        }],
        index: false,
      }, { lineWidth: 120, noRefs: true }),
    )
    const plur = new Plur({ path: primaryDir })

    plur.learn('should stay local due to readonly', {
      scope: 'group:test',
      type: 'behavioral',
    })

    await new Promise(r => setTimeout(r, 50))

    // Server should NOT have it
    expect(server.engramCount).toBe(0)

    // Local should have it
    const localYaml = join(primaryDir, 'engrams.yaml')
    expect(existsSync(localYaml)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ID prefix round-trip — the #86 regression test
// ---------------------------------------------------------------------------

describe('ID prefix round-trip (issue #86)', () => {
  let primaryDir: string

  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'plur-prefix-'))
    server.reset()
    writeFileSync(
      join(primaryDir, 'config.yaml'),
      yaml.dump({
        stores: [{
          url: baseUrl,
          token: TOKEN,
          scope: 'group:test',
          shared: true,
          readonly: false,
        }],
        index: false,
      }, { lineWidth: 120, noRefs: true }),
    )
  })

  afterAll(() => {
    if (primaryDir && existsSync(primaryDir)) rmSync(primaryDir, { recursive: true, force: true })
  })

  it('feedback() works with prefixed ID from _loadAllEngrams', async () => {
    const plur = new Plur({ path: primaryDir })

    // Learn to remote
    plur.learn('remote engram for feedback test', { scope: 'group:test', type: 'behavioral' })
    await new Promise(r => setTimeout(r, 100))
    expect(server.engramCount).toBe(1)

    // Load engrams — this adds the store prefix (e.g. ENG-GTE-...)
    const loaded = plur.list({ scope: 'group:test' })

    // Wait for remote cache to populate
    await new Promise(r => setTimeout(r, 2000))
    const loadedAfter = plur.list({ scope: 'group:test' })
    const remoteEngrams = loadedAfter.filter(e => e.id.includes('-GTE-'))
    expect(remoteEngrams.length).toBeGreaterThanOrEqual(1)

    const prefixedId = remoteEngrams[0].id
    expect(prefixedId).toMatch(/^ENG-GTE-/) // Prefixed

    // Feedback with the prefixed ID — should succeed, not "Engram not found"
    await plur.feedback(prefixedId, 'positive')

    // Verify the server received the feedback (on the unprefixed ID)
    const serverEngram = server.getEngram('ENG-SRV-001')
    expect(serverEngram).toBeTruthy()
    expect((serverEngram?.data as any)?.feedback_signals?.positive).toBeGreaterThanOrEqual(1)
  })

  it('forget() works with prefixed ID from _loadAllEngrams', async () => {
    const plur = new Plur({ path: primaryDir })

    // Learn to remote
    plur.learn('remote engram for forget test', { scope: 'group:test', type: 'behavioral' })
    await new Promise(r => setTimeout(r, 100))
    expect(server.engramCount).toBe(1)

    // Wait for remote cache to populate
    await new Promise(r => setTimeout(r, 2000))
    const loaded = plur.list({ scope: 'group:test' })
    const remoteEngrams = loaded.filter(e => e.id.includes('-GTE-'))
    expect(remoteEngrams.length).toBeGreaterThanOrEqual(1)

    const prefixedId = remoteEngrams[0].id
    expect(prefixedId).toMatch(/^ENG-GTE-/)

    // Forget with the prefixed ID — should succeed
    await plur.forget(prefixedId)

    // Verify the server retired it
    const serverEngram = server.getEngram('ENG-SRV-001')
    expect(serverEngram?.status).toBe('retired')
  })

  it('feedback() still works with unprefixed server ID', async () => {
    const plur = new Plur({ path: primaryDir })

    // Learn to remote
    plur.learn('remote engram for unprefixed test', { scope: 'group:test', type: 'behavioral' })
    await new Promise(r => setTimeout(r, 100))

    // Feedback with the server-side ID directly (no prefix)
    await plur.feedback('ENG-SRV-001', 'positive')

    const serverEngram = server.getEngram('ENG-SRV-001')
    expect((serverEngram?.data as any)?.feedback_signals?.positive).toBeGreaterThanOrEqual(1)
  })
})

/**
 * Remote routing for pin / promote / reportFailure (issue #185 + #86 remainder).
 *
 * Closes the pin/promote/reportFailure gap left by #86 — these mutations
 * used to write only to the local primary store, silently failing when the
 * engram lived on a remote server. The Enterprise PATCH /api/v1/engrams/:id
 * endpoint (PR #111) is now consumed by RemoteStore.patch(), and setPinned,
 * updateEngram, and reportFailure route to remote when the engram lives there.
 */
describe('Remote mutation routing — pin / promote / reportFailure (#185, #86)', () => {
  let primaryDir: string

  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'plur-mutation-'))
    server.reset()
    writeFileSync(
      join(primaryDir, 'config.yaml'),
      yaml.dump({
        stores: [{
          url: baseUrl,
          token: TOKEN,
          scope: 'group:test',
          shared: true,
          readonly: false,
        }],
        index: false,
      }, { lineWidth: 120, noRefs: true }),
    )
  })

  afterAll(() => {
    if (primaryDir && existsSync(primaryDir)) rmSync(primaryDir, { recursive: true, force: true })
  })

  it('setPinnedAsync(prefixedId, true) reaches remote server via PATCH', async () => {
    const plur = new Plur({ path: primaryDir })

    // Learn to remote
    plur.learn('engram to pin', { scope: 'group:test', type: 'behavioral' })
    await new Promise(r => setTimeout(r, 100))
    await new Promise(r => setTimeout(r, 2000)) // cache populate

    const loaded = plur.list({ scope: 'group:test' })
    const remoteEngrams = loaded.filter(e => e.id.includes('-GTE-'))
    expect(remoteEngrams.length).toBeGreaterThanOrEqual(1)
    const prefixedId = remoteEngrams[0].id
    expect(prefixedId).toMatch(/^ENG-GTE-/)

    // Pin via the async variant — must reach the server (unprefixed)
    const patched = await plur.setPinnedAsync(prefixedId, true)
    expect(patched).toBeTruthy()

    // Verify the server received the pin
    const serverEngram = server.getEngram('ENG-SRV-001')
    expect((serverEngram?.data as any)?.pinned).toBe(true)
  })

  it('updateEngramAsync routes statement change to remote (promote path)', async () => {
    const plur = new Plur({ path: primaryDir })

    plur.learn('original procedure', { scope: 'group:test', type: 'procedural' })
    await new Promise(r => setTimeout(r, 100))
    await new Promise(r => setTimeout(r, 2000))

    const loaded = plur.list({ scope: 'group:test' })
    const remoteEngrams = loaded.filter(e => e.id.includes('-GTE-'))
    expect(remoteEngrams.length).toBeGreaterThanOrEqual(1)
    const target = remoteEngrams[0]

    // Promote-style update: change status + statement, send via updateEngramAsync
    const updated = { ...target, statement: 'rewritten procedure', status: 'active' as const }
    const result = await plur.updateEngramAsync(updated)
    expect(result).toBeTruthy()

    // Server should reflect the new statement
    const serverEngram = server.getEngram('ENG-SRV-001')
    expect((serverEngram?.data as any)?.statement).toBe('rewritten procedure')
  })

  it('reportFailure with LLM rewrite routes new statement to remote', async () => {
    const plur = new Plur({ path: primaryDir })

    plur.learn('flaky procedure that fails', { scope: 'group:test', type: 'procedural' })
    await new Promise(r => setTimeout(r, 100))
    await new Promise(r => setTimeout(r, 2000))

    const loaded = plur.list({ scope: 'group:test' })
    const remoteEngrams = loaded.filter(e => e.id.includes('-GTE-'))
    const target = remoteEngrams[0]

    // Mock LLM that returns an improved version
    const llm = async () => 'improved procedure that handles the failure case'

    const result = await plur.reportFailure(target.id, 'failed on edge case X', llm)
    expect(result.evolved).toBe(true)
    expect(result.engram.statement).toBe('improved procedure that handles the failure case')

    // Server should have the improved statement
    const serverEngram = server.getEngram('ENG-SRV-001')
    expect((serverEngram?.data as any)?.statement).toBe('improved procedure that handles the failure case')
  })

  it('updateEngramAsync returns null when ID not found in any store', async () => {
    const plur = new Plur({ path: primaryDir })
    const fakeEngram = {
      id: 'ENG-GTE-DOES-NOT-EXIST',
      version: 2,
      status: 'active' as const,
      consolidated: false,
      type: 'behavioral' as const,
      scope: 'group:test',
      visibility: 'private' as const,
      statement: 'phantom',
      activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-01-01' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_anchors: [],
      associations: [],
      derivation_count: 1,
      tags: [],
      pack: null,
      abstract: null,
      derived_from: null,
      polarity: null,
      engram_version: 1,
      episode_ids: [],
      reference_count: 1,
      sources: [],
    } as any
    const result = await plur.updateEngramAsync(fakeEngram)
    expect(result).toBeNull()
  })

  it('setPinnedAsync against a readonly remote returns null', async () => {
    // Reset config with readonly remote
    rmSync(join(primaryDir, 'config.yaml'))
    writeFileSync(
      join(primaryDir, 'config.yaml'),
      yaml.dump({
        stores: [{
          url: baseUrl,
          token: TOKEN,
          scope: 'group:test',
          shared: true,
          readonly: true,
        }],
        index: false,
      }, { lineWidth: 120, noRefs: true }),
    )

    // Seed an engram directly on the server (since the store is readonly)
    server.seedEngram({
      id: 'ENG-RO-001',
      scope: 'group:test',
      status: 'active',
      data: { statement: 'readonly engram', scope: 'group:test', status: 'active' },
    })

    const plur = new Plur({ path: primaryDir })
    const result = await plur.setPinnedAsync('ENG-GTE-RO-001', true)
    expect(result).toBeNull()

    // Server should NOT have been patched
    const serverEngram = server.getEngram('ENG-RO-001')
    expect((serverEngram?.data as any)?.pinned).toBeUndefined()
  })
})
