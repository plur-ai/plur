import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

// Iter-2 audit M-3: pin sqlite. session-scope tests use a hung fetch mock
// to test timeout behavior, not local indexing. PGLite WASM init adds
// flakiness without coverage value here.
const originalBackend = process.env.PLUR_BACKEND
process.env.PLUR_BACKEND = 'sqlite'

function writeStoresConfig(dir: string, stores: Array<Record<string, unknown>>) {
  writeFileSync(
    join(dir, 'config.yaml'),
    yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }),
  )
}

describe('session scope (#229)', () => {
  let primaryDir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'plur-session-scope-'))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(primaryDir, { recursive: true, force: true })
  })

  function mockRemote() {
    fetchMock.mockImplementation((async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return {
          ok: true, status: 201,
          json: async () => ({ id: 'ENG-REMOTE-001' }),
          text: async () => '',
        } as Response
      }
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

  // --- getSessionScope / setSessionScope ---

  it('getSessionScope returns null by default', () => {
    const plur = new Plur({ path: primaryDir })
    expect(plur.getSessionScope()).toBeNull()
  })

  it('setSessionScope / getSessionScope roundtrip', () => {
    const plur = new Plur({ path: primaryDir })
    plur.setSessionScope('group:plur/plur-ai/engineering')
    expect(plur.getSessionScope()).toBe('group:plur/plur-ai/engineering')
  })

  it('setSessionScope(null) resets to null', () => {
    const plur = new Plur({ path: primaryDir })
    plur.setSessionScope('group:test')
    plur.setSessionScope(null)
    expect(plur.getSessionScope()).toBeNull()
  })

  // --- getWritableRemoteScopes ---

  it('getWritableRemoteScopes returns empty when no stores configured', () => {
    const plur = new Plur({ path: primaryDir })
    expect(plur.getWritableRemoteScopes()).toEqual([])
  })

  it('getWritableRemoteScopes returns empty when all stores are filesystem', () => {
    writeStoresConfig(primaryDir, [
      { path: '/tmp/test.yaml', scope: 'project:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    expect(plur.getWritableRemoteScopes()).toEqual([])
  })

  it('getWritableRemoteScopes excludes readonly remote stores', () => {
    mockRemote()
    writeStoresConfig(primaryDir, [
      { url: 'https://readonly.example.com/sse', scope: 'group:readonly', shared: true, readonly: true },
    ])
    const plur = new Plur({ path: primaryDir })
    expect(plur.getWritableRemoteScopes()).toEqual([])
  })

  it('getWritableRemoteScopes returns writable remote stores', () => {
    mockRemote()
    writeStoresConfig(primaryDir, [
      { url: 'https://enterprise.example.com/sse', scope: 'group:plur/eng', shared: true, readonly: false },
      { path: '/tmp/local.yaml', scope: 'project:local', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    expect(plur.getWritableRemoteScopes()).toEqual([
      { scope: 'group:plur/eng', url: 'https://enterprise.example.com/sse' },
    ])
  })

  // --- learn() uses session scope as fallback ---

  it('learn() uses session scope when no explicit scope provided', () => {
    const plur = new Plur({ path: primaryDir })
    plur.setSessionScope('group:my-team')
    const engram = plur.learn('session scope test')
    expect(engram.scope).toBe('group:my-team')
  })

  it('learn() uses explicit scope over session scope', () => {
    const plur = new Plur({ path: primaryDir })
    plur.setSessionScope('group:my-team')
    const engram = plur.learn('explicit scope test', { scope: 'project:override' })
    expect(engram.scope).toBe('project:override')
  })

  it('learn() falls back to global when no session scope set', () => {
    const plur = new Plur({ path: primaryDir })
    const engram = plur.learn('global fallback test')
    expect(engram.scope).toBe('global')
  })

  // --- learnRouted() uses session scope for remote routing ---

  it('learnRouted() routes to remote store via session scope', async () => {
    mockRemote()
    writeStoresConfig(primaryDir, [
      { url: 'https://enterprise.example.com/sse', token: 'test_token', scope: 'group:plur/eng', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    plur.setSessionScope('group:plur/eng')

    // Call without explicit scope — should use session scope and route to remote
    const engram = await plur.learnRouted('routed via session scope')

    expect(engram.id).toBe('ENG-REMOTE-001')
    expect(engram.scope).toBe('group:plur/eng')

    const posts = postCalls()
    expect(posts.length).toBe(1)
    expect(posts[0][0]).toContain('/api/v1/engrams')
  })

  it('learnRouted() does not route to remote when session scope does not match', async () => {
    mockRemote()
    writeStoresConfig(primaryDir, [
      { url: 'https://enterprise.example.com/sse', token: 'test_token', scope: 'group:plur/eng', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    plur.setSessionScope('group:other-team')

    const engram = await plur.learnRouted('stays local')

    // Should NOT have posted to remote
    const posts = postCalls()
    expect(posts.length).toBe(0)
    // Should be local with the session scope
    expect(engram.scope).toBe('group:other-team')
  })

  it('learnRouted() explicit scope overrides session scope', async () => {
    mockRemote()
    writeStoresConfig(primaryDir, [
      { url: 'https://enterprise.example.com/sse', token: 'test_token', scope: 'group:plur/eng', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    plur.setSessionScope('group:wrong')

    const engram = await plur.learnRouted('explicit wins', { scope: 'group:plur/eng' })

    expect(engram.id).toBe('ENG-REMOTE-001')
    const posts = postCalls()
    expect(posts.length).toBe(1)
  })

  // --- warmRemoteCaches (#235) ---

  it('warmRemoteCaches loads remote store data into cache', async () => {
    fetchMock.mockImplementation((async (url: string) => {
      return {
        ok: true, status: 200,
        json: async () => ({
          rows: [{ id: 'ENG-WARM-001', scope: 'group:plur/eng', status: 'active', data: { statement: 'warm test' } }],
          total_count: 1,
        }),
        text: async () => '',
      } as Response
    }) as any)

    writeStoresConfig(primaryDir, [
      { url: 'https://enterprise.example.com/sse', token: 'test_token', scope: 'group:plur/eng', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    // Before warming — _loadAllEngrams won't have remote data yet on cold start
    await plur.warmRemoteCaches()

    // After warming — remote engrams should be in the merged view
    const all = (plur as any)._loadAllEngrams() as Array<{ id: string; statement?: string }>
    const remoteEngram = all.find(e => e.id.includes('WARM-001'))
    expect(remoteEngram).toBeDefined()
  })

  it('warmRemoteCaches handles unreachable remote gracefully', async () => {
    fetchMock.mockImplementation((async () => {
      throw new Error('Network error')
    }) as any)

    writeStoresConfig(primaryDir, [
      { url: 'https://down.example.com/sse', token: 'test_token', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    // Should not throw
    await expect(plur.warmRemoteCaches()).resolves.toBeUndefined()
  })

  it('warmRemoteCaches with no remote stores is a no-op', async () => {
    const plur = new Plur({ path: primaryDir })
    await expect(plur.warmRemoteCaches()).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── Cross-session safety (review fixes on PR #230) ────────────────────────
  // The MCP server is one long-lived process serving many sequential
  // session_start calls. Without explicit reset, default_scope from session
  // A would leak into every subsequent session B that didn't pass its own.

  it('setSessionScope(null) clears a previously-set scope (cross-session safety)', () => {
    const plur = new Plur({ path: primaryDir })
    plur.setSessionScope('group:session-a')
    expect(plur.getSessionScope()).toBe('group:session-a')

    // New session starts without a default_scope → reset
    plur.setSessionScope(null)
    expect(plur.getSessionScope()).toBeNull()

    // Subsequent learn() without explicit scope falls back to 'global', not the
    // previously-set group:session-a
    const engram = plur.learn('no scope leakage')
    expect(engram.scope).toBe('global')
  })

  it('warmRemoteCaches with hung remote returns within timeout window', async () => {
    // Simulate a hung remote (never resolves). Without the 5s timeout, this
    // would block session_start indefinitely.
    fetchMock.mockImplementation((async () => {
      return new Promise<Response>(() => { /* never resolves */ })
    }) as any)

    writeStoresConfig(primaryDir, [
      { url: 'https://hung.example.com/sse', token: 'test_token', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    const start = Date.now()
    await plur.warmRemoteCaches()
    const elapsed = Date.now() - start

    // 5s timeout + small buffer for the race to fire
    expect(elapsed).toBeLessThan(7000)
    expect(elapsed).toBeGreaterThanOrEqual(4500)
  }, 10000)
})
