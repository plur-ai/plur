import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
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
})
