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

  it('logs but does not throw if remote append fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'server boom' }),
      text: async () => 'server boom',
    } as Response)

    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})

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
    expect(() => {
      plur.learn('engram-with-failing-remote', {
        scope: 'group:plur/plur-ai/engineering',
        type: 'behavioral',
      })
    }).not.toThrow()

    // Wait for the fire-and-forget rejection handler to run.
    await new Promise(r => setTimeout(r, 10))
    expect(consoleErr).toHaveBeenCalled()
    const errCall = consoleErr.mock.calls.find(c => String(c[1] ?? '').includes('remote append failed'))
    expect(errCall).toBeDefined()
    consoleErr.mockRestore()
  })
})

/**
 * Issue #84 — forget() must route to remote stores when the engram
 * is not found locally. RemoteStore.getById() + .remove() handle the
 * server-side retirement.
 */
describe('forget() — remote routing (issue #84)', () => {
  let primaryDir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'plur-forget-'))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(primaryDir, { recursive: true, force: true })
  })

  function postCalls() {
    return fetchMock.mock.calls.filter(([, init]) => (init as any)?.method === 'POST')
  }
  function deleteCalls() {
    return fetchMock.mock.calls.filter(([, init]) => (init as any)?.method === 'DELETE')
  }
  function getCalls() {
    return fetchMock.mock.calls.filter(([, init]) => !(init as any)?.method || (init as any)?.method === 'GET')
  }

  function mockRemoteWithEngram(id: string) {
    fetchMock.mockImplementation((async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      // GET /engrams/:id — found
      if (method === 'GET' && typeof url === 'string' && url.includes(`/engrams/${id}`)) {
        return {
          ok: true, status: 200,
          json: async () => ({ id, scope: 'group:test', status: 'active', data: { statement: 'test' } }),
          text: async () => '',
        } as Response
      }
      // DELETE /engrams/:id — success
      if (method === 'DELETE' && typeof url === 'string' && url.includes(`/engrams/${id}`)) {
        return {
          ok: true, status: 200,
          json: async () => ({ id, status: 'retired' }),
          text: async () => '',
        } as Response
      }
      // GET /engrams?scope=... (load) — empty list
      if (method === 'GET') {
        return {
          ok: true, status: 200,
          json: async () => ({ rows: [], total_count: 0 }),
          text: async () => '',
        } as Response
      }
      return { ok: false, status: 404, text: async () => 'not found' } as Response
    }) as any)
  }

  function mockRemoteEmpty() {
    fetchMock.mockImplementation((async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && typeof url === 'string' && url.includes('/engrams/ENG-')) {
        return { ok: false, status: 404, json: async () => null, text: async () => '' } as Response
      }
      return {
        ok: true, status: 200,
        json: async () => ({ rows: [], total_count: 0 }),
        text: async () => '',
      } as Response
    }) as any)
  }

  it('forget routes to remote when engram not found locally', async () => {
    mockRemoteWithEngram('ENG-REMOTE-001')

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    // Should NOT throw — the engram is on the remote
    await plur.forget('ENG-REMOTE-001', 'no longer needed')

    // Verify DELETE was called
    const deletes = deleteCalls()
    expect(deletes.length).toBe(1)
    expect(deletes[0][0]).toContain('/engrams/ENG-REMOTE-001')
  })

  it('forget logs history with routed_to: remote', async () => {
    mockRemoteWithEngram('ENG-REMOTE-002')

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    await plur.forget('ENG-REMOTE-002', 'test reason')

    // Check history file
    const historyDir = join(primaryDir, 'history')
    const files = existsSync(historyDir) ? readdirSync(historyDir) : []
    expect(files.length).toBeGreaterThan(0)

    const historyContent = readFileSync(join(historyDir, files[0]), 'utf-8')
    expect(historyContent).toContain('engram_retired')
    expect(historyContent).toContain('ENG-REMOTE-002')
    expect(historyContent).toContain('remote')
  })

  it('forget prefers local over remote', async () => {
    // If the engram exists locally, it should retire locally without hitting remote
    mockRemoteWithEngram('ENG-LOCAL-001')

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    // Create a local engram first
    const engram = plur.learn('local engram to retire', { scope: 'global' })

    // Forget it — should retire locally, no remote calls for getById/DELETE
    await plur.forget(engram.id)

    // Only GET calls should be from the learn() dedup load, not from forget
    const deletes = deleteCalls()
    expect(deletes.length).toBe(0)

    // Verify local retirement
    const found = plur.getById(engram.id)
    expect(found!.status).toBe('retired')
  })

  it('forget on readonly remote throws clear error', async () => {
    mockRemoteWithEngram('ENG-READONLY-001')

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: true },
    ])
    const plur = new Plur({ path: primaryDir })

    await expect(plur.forget('ENG-READONLY-001')).rejects.toThrow('Cannot retire engram from readonly store')
  })

  it('forget throws when engram not in local or remote', async () => {
    mockRemoteEmpty()

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    await expect(plur.forget('ENG-NONEXISTENT-001')).rejects.toThrow('Engram not found')
  })

  it('forget handles remote server error gracefully', async () => {
    // getById throws a network error
    fetchMock.mockImplementation((async () => {
      throw new Error('Network error: connection refused')
    }) as any)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    // RemoteStore.getById catches errors and returns null, so this falls through to "not found"
    await expect(plur.forget('ENG-NETERR-001')).rejects.toThrow('Engram not found')
  })
})
