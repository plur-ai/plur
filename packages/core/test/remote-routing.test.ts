import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

function writeStoresConfig(dir: string, stores: Array<Record<string, unknown>>) {
  writeFileSync(
    join(dir, 'config.yaml'),
    yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }),
  )
}

/**
 * Issue #25 — `plur_learn` with a scope matching a registered remote store
 * must POST the engram to /api/v1/engrams on that remote, NOT write it to
 * the local YAML store. Engrams without a matching remote stay local.
 */
describe('learn() — remote routing (issue #25)', () => {
  let primaryDir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'plur-routing-'))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(primaryDir, { recursive: true, force: true })
  })

  function mockSuccessfulAppend() {
    // Mock both reads (GET /engrams?scope=…) and the POST append.
    // Reads happen because _loadAllEngrams() pulls from every registered
    // store (including remote ones) for hash-dedup before learn writes.
    fetchMock.mockImplementation((async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return {
          ok: true, status: 201,
          json: async () => ({ id: 'ENG-REMOTE-001' }),
          text: async () => '',
        } as Response
      }
      // Default: empty list response from the load() page-walk
      return {
        ok: true, status: 200,
        json: async () => ({ rows: [], total_count: 0 }),
        text: async () => '',
      } as Response
    }) as any)
  }

  function postCalls() {
    return fetchMock.mock.calls.filter(([, init]) => (init as any)?.method === 'POST')
  }

  it('routes a learn() with matching scope to RemoteStore.append (no local write)', async () => {
    mockSuccessfulAppend()

    writeStoresConfig(primaryDir, [
      {
        url: 'https://plur.example.com/sse',
        token: 'plur_sk_test',
        scope: 'group:plur/plur-ai/engineering',
        shared: true,
        readonly: false,
      },
    ])
    const plur = new Plur({ path: primaryDir })

    const engram = plur.learn('test engram for remote', {
      scope: 'group:plur/plur-ai/engineering',
      type: 'behavioral',
    })

    expect(engram.scope).toBe('group:plur/plur-ai/engineering')
    expect(engram.statement).toBe('test engram for remote')

    // Network POST to /api/v1/engrams should have been made (fire-and-forget;
    // give the microtask queue a tick to drain).
    await new Promise(r => setTimeout(r, 10))
    const posts = postCalls()
    expect(posts.length).toBe(1)
    const [url, init] = posts[0]
    expect(url).toBe('https://plur.example.com/api/v1/engrams')
    const body = JSON.parse((init as any).body)
    expect(body.statement).toBe('test engram for remote')
    expect(body.scope).toBe('group:plur/plur-ai/engineering')

    // Local YAML must NOT contain the engram — the entire point of #25.
    const localYaml = join(primaryDir, 'engrams.yaml')
    if (existsSync(localYaml)) {
      const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams?: unknown[] } | null
      const engrams = (local?.engrams ?? []) as Array<{ statement?: string }>
      expect(engrams.find(e => e.statement === 'test engram for remote')).toBeUndefined()
    }
  })

  it('writes locally when scope does NOT match any remote store', () => {
    writeStoresConfig(primaryDir, [
      {
        url: 'https://plur.example.com/sse',
        token: 'plur_sk_test',
        scope: 'group:plur/plur-ai/engineering',
        shared: true,
        readonly: false,
      },
    ])
    const plur = new Plur({ path: primaryDir })

    const engram = plur.learn('local-only engram', {
      scope: 'global',
      type: 'behavioral',
    })

    expect(engram.scope).toBe('global')
    expect(postCalls().length).toBe(0)

    const localYaml = join(primaryDir, 'engrams.yaml')
    expect(existsSync(localYaml)).toBe(true)
    const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams: Array<{ statement: string }> }
    expect(local.engrams.find(e => e.statement === 'local-only engram')).toBeTruthy()
  })

  it('writes locally when remote store entry is readonly', () => {
    writeStoresConfig(primaryDir, [
      {
        url: 'https://plur.example.com/sse',
        token: 'plur_sk_test',
        scope: 'group:plur/plur-ai/engineering',
        shared: true,
        readonly: true, // ← read-only — writes must stay local
      },
    ])
    const plur = new Plur({ path: primaryDir })

    plur.learn('readonly-store engram', {
      scope: 'group:plur/plur-ai/engineering',
      type: 'behavioral',
    })

    expect(postCalls().length).toBe(0)
    const localYaml = join(primaryDir, 'engrams.yaml')
    const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams: Array<{ statement: string }> }
    expect(local.engrams.find(e => e.statement === 'readonly-store engram')).toBeTruthy()
  })

  it('does not throw if remote append fails — saves locally with _routed:false', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'server boom' }),
      text: async () => 'server boom',
    } as Response)

    writeStoresConfig(primaryDir, [
      {
        url: 'https://plur.example.com/sse',
        token: 'plur_sk_test',
        scope: 'group:plur/plur-ai/engineering',
        shared: true,
        readonly: false,
      },
    ])
    const plur = new Plur({ path: primaryDir })

    // Should NOT throw — the engram object still comes back.
    const engram = plur.learn('engram-with-failing-remote', {
      scope: 'group:plur/plur-ai/engineering',
      type: 'behavioral',
    })
    expect(engram.statement).toBe('engram-with-failing-remote')

    // Wait for the background retry (2 attempts) + local fallback to complete.
    await new Promise(r => setTimeout(r, 50))

    // Engram should now be in local store with outbox metadata.
    const localYaml = join(primaryDir, 'engrams.yaml')
    expect(existsSync(localYaml)).toBe(true)
    const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams: any[] }
    const saved = local.engrams.find(e => e.statement === 'engram-with-failing-remote')
    expect(saved).toBeDefined()
    expect(saved._routed).toBe(false)
    expect(saved._intended_scope).toBe('group:plur/plur-ai/engineering')
    expect(saved._route_attempts).toBe(2)
  })
})

/**
 * Issue #88 — learn() retry + local fallback for remote store failures.
 * When remote append fails, retry once, then save locally with outbox
 * metadata (_routed:false) so #26 can re-publish later.
 */
describe('learn() — retry + local fallback (issue #88)', () => {
  let primaryDir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'plur-retry-'))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(primaryDir, { recursive: true, force: true })
  })

  it('retries once and succeeds — no local fallback', async () => {
    let callCount = 0
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        callCount++
        if (callCount === 1) {
          // First attempt fails
          return { ok: false, status: 500, json: async () => ({}), text: async () => 'server error' } as Response
        }
        // Second attempt succeeds
        return { ok: true, status: 201, json: async () => ({ id: 'ENG-SRV-RETRY' }), text: async () => '' } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    }) as any)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    plur.learn('retry-success', { scope: 'group:test', type: 'behavioral' })

    await new Promise(r => setTimeout(r, 50))

    // Two POST calls made (initial + retry)
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as any)?.method === 'POST')
    expect(posts.length).toBe(2)

    // NOT saved locally — remote succeeded on retry
    const localYaml = join(primaryDir, 'engrams.yaml')
    if (existsSync(localYaml)) {
      const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams?: any[] } | null
      const found = (local?.engrams ?? []).find((e: any) => e.statement === 'retry-success')
      expect(found).toBeUndefined()
    }
  })

  it('succeeds on first attempt — no retry, no fallback', async () => {
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ id: 'ENG-SRV-OK' }), text: async () => '' } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    }) as any)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    plur.learn('first-attempt-ok', { scope: 'group:test', type: 'behavioral' })

    await new Promise(r => setTimeout(r, 50))

    // Only one POST call
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as any)?.method === 'POST')
    expect(posts.length).toBe(1)

    // NOT saved locally
    const localYaml = join(primaryDir, 'engrams.yaml')
    if (existsSync(localYaml)) {
      const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams?: any[] } | null
      const found = (local?.engrams ?? []).find((e: any) => e.statement === 'first-attempt-ok')
      expect(found).toBeUndefined()
    }
  })

  it('fallback logs engram_route_failed history event', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 503,
      json: async () => ({}), text: async () => 'service unavailable',
    } as Response)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    plur.learn('history-fallback-test', { scope: 'group:test', type: 'behavioral' })

    await new Promise(r => setTimeout(r, 50))

    const historyDir = join(primaryDir, 'history')
    const files = existsSync(historyDir) ? readdirSync(historyDir) : []
    expect(files.length).toBeGreaterThan(0)

    // Should have both engram_created (optimistic) and engram_route_failed
    const allHistory = files.map(f => readFileSync(join(historyDir, f), 'utf-8')).join('\n')
    expect(allHistory).toContain('engram_route_failed')
    expect(allHistory).toContain('local_fallback')
  })

  it('network error triggers fallback (not just HTTP errors)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    plur.learn('network-error-test', { scope: 'group:test', type: 'behavioral' })

    await new Promise(r => setTimeout(r, 50))

    const localYaml = join(primaryDir, 'engrams.yaml')
    expect(existsSync(localYaml)).toBe(true)
    const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams: any[] }
    const saved = local.engrams.find(e => e.statement === 'network-error-test')
    expect(saved).toBeDefined()
    expect(saved._routed).toBe(false)
  })
})
