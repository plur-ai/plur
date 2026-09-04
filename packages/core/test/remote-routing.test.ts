import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

/**
 * Wait until `cond` holds, or fail after `timeoutMs`.
 *
 * Replaces fixed sleeps in this file. `learn()` saves locally, pushes async,
 * then deletes the local copy, and a fixed `setTimeout(100)` asserts that the
 * whole cycle finished in under 100 ms on whatever machine happens to run it.
 * That is a race, and it lost on the Node 20 runner once the history append
 * got a lock (#1051): 22, 24 and 26 passed, 20 did not, on identical code.
 *
 * Polling turns a guess about duration into a statement about the condition —
 * and it fails with the same assertion either way, so a real regression still
 * shows up rather than being slept past.
 */
async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (cond()) return
    if (Date.now() > deadline) return // caller's expect() reports the failure
    await new Promise(r => setTimeout(r, stepMs))
  }
}

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

    const engram = await plur.learn('test engram for remote', {
      scope: 'group:plur/plur-ai/engineering',
      type: 'behavioral',
    })

    expect(engram.scope).toBe('group:plur/plur-ai/engineering')
    expect(engram.statement).toBe('test engram for remote')

    // Network POST to /api/v1/engrams should have been made. With the
    // outbox pattern (issue #26), learn() saves locally first then pushes
    // async — wait for the write-then-delete cycle to actually finish rather
    // than guessing how long it takes.
    await waitFor(() => postCalls().length >= 1)
    const posts = postCalls()
    expect(posts.length).toBe(1)
    const [url, init] = posts[0]
    expect(url).toBe('https://plur.example.com/api/v1/engrams')
    const body = JSON.parse((init as any).body)
    expect(body.statement).toBe('test engram for remote')
    expect(body.scope).toBe('group:plur/plur-ai/engineering')

    // After successful remote push, the local outbox copy should be
    // removed — no engram left in local YAML.
    const localYaml = join(primaryDir, 'engrams.yaml')
    const localCopyGone = (): boolean => {
      if (!existsSync(localYaml)) return true
      const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams?: unknown[] } | null
      const engrams = (local?.engrams ?? []) as Array<{ statement?: string }>
      return engrams.find(e => e.statement === 'test engram for remote') === undefined
    }
    await waitFor(localCopyGone)
    if (existsSync(localYaml)) {
      const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams?: unknown[] } | null
      const engrams = (local?.engrams ?? []) as Array<{ statement?: string }>
      expect(engrams.find(e => e.statement === 'test engram for remote')).toBeUndefined()
    }
  })

  it('writes locally when scope does NOT match any remote store', async () => {
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

    const engram = await plur.learn('local-only engram', {
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

  it('writes locally when remote store entry is readonly', async () => {
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

    await plur.learn('readonly-store engram', {
      scope: 'group:plur/plur-ai/engineering',
      type: 'behavioral',
    })

    expect(postCalls().length).toBe(0)
    const localYaml = join(primaryDir, 'engrams.yaml')
    const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams: Array<{ statement: string }> }
    expect(local.engrams.find(e => e.statement === 'readonly-store engram')).toBeTruthy()
  })

  it('saves to outbox when remote append fails (issue #26)', async () => {
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return {
          ok: false, status: 500,
          json: async () => ({ error: 'server boom' }),
          text: async () => 'server boom',
        } as Response
      }
      return {
        ok: true, status: 200,
        json: async () => ({ rows: [], total_count: 0 }),
        text: async () => '',
      } as Response
    }) as any)

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

    // Should NOT throw — the engram is saved to local outbox.
    // Should NOT reject — the engram is saved to the local outbox.
    await expect(plur.learn('engram-with-failing-remote', {
      scope: 'group:plur/plur-ai/engineering',
      type: 'behavioral',
    })).resolves.toBeDefined()

    // Wait for the fire-and-forget push attempt to settle.
    await new Promise(r => setTimeout(r, 50))

    // Engram should be in local YAML with outbox metadata (issue #26).
    const localYaml = join(primaryDir, 'engrams.yaml')
    const local = yaml.load(readFileSync(localYaml, 'utf-8')) as { engrams: Array<{ statement: string; structured_data?: any }> }
    const found = local.engrams.find(e => e.statement === 'engram-with-failing-remote')
    expect(found).toBeDefined()
    expect(found!.structured_data?._outbox).toBeDefined()
    expect(found!.structured_data._outbox.target_scope).toBe('group:plur/plur-ai/engineering')
  })

  // #1109 — learnRouted catch-block gap: the fallback path (plur.learn inside
  // the catch) returned engram.id raw, the same collision risk as before #914
  // if learnRouted throws and learn falls back for a remote-backed scope.
  // readIdFor must be applied here too so the returned ID matches recall.
  it('readIdFor returns namespaced form for a remote-backed scope', async () => {
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

    // learnRouted returns the server's raw ID; readIdFor converts it to the
    // namespaced form that recall surfaces so both sides agree on the key.
    const engram = await plur.learnRouted('test for readIdFor namespacing', {
      scope: 'group:plur/plur-ai/engineering',
    })
    // Wait for the async push to settle before reading the returned id.
    await new Promise(r => setTimeout(r, 100))

    const readId = plur.readIdFor(engram)
    // storePrefix('group:plur/plur-ai/engineering') → 'GPL'
    expect(readId).toMatch(/^ENG-GPL-/)
    // The raw engram.id is the server-assigned bare form.
    expect(engram.id).not.toMatch(/^ENG-GPL-/)
    // The namespaced form differs from the raw form.
    expect(readId).not.toBe(engram.id)
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
    const files = existsSync(historyDir) ? readdirSync(historyDir).filter(f => f.endsWith('.jsonl')) : []
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
    const engram = await plur.learn('local engram to retire', { scope: 'global' })

    // Forget it — should retire locally, no remote calls for getById/DELETE
    await plur.forget(engram.id)

    // Only GET calls should be from the learn() dedup load, not from forget
    const deletes = deleteCalls()
    expect(deletes.length).toBe(0)

    // Verify local retirement
    const found = await plur.getById(engram.id)
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

  // #831 — ids are minted per store, so one bare id can name several unrelated
  // engrams. `forget` resolved primary-first and retired whichever it reached,
  // reporting success and echoing a statement the caller never wrote. In real
  // use that destroyed the wrong engram: plur_history for ENG-2026-08-03-008
  // shows three creations across three scopes; the retire hit the 11:32 one
  // when the caller meant the 19:15 one.
  //
  // Mirrors the feedback disambiguation in #850/#851: an unqualified id that
  // resolves in more than one place is an ERROR, not a coin flip. Destructive
  // ambiguity has to refuse rather than pick.
  describe('ambiguous ids across stores (#831)', () => {
    /**
     * Seed the LOCAL primary store with a chosen id. `learn()` cannot do this —
     * `LearnContext` has no `id` and the store mints its own — and a generated
     * id would never collide, which is the entire condition under test.
     */
    function seedLocal(id: string, statement: string) {
      writeFileSync(join(primaryDir, 'engrams.yaml'), yaml.dump({
        engrams: [{
          id, version: 2, status: 'active', consolidated: false,
          type: 'behavioral', scope: 'global', visibility: 'private', statement,
          activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-08-10' },
          feedback_signals: { positive: 0, negative: 0, neutral: 0 },
          knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
          knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], pack: null,
          abstract: null, derived_from: null, polarity: null, content_hash: `h-${id}`,
          commitment: 'leaning', reference_count: 1, sources: [], recurrence_count: 0,
          summary: statement, engram_version: 1, episode_ids: [],
        }],
      }), 'utf8')
    }

    async function warmedCollision(id: string) {
      writeStoresConfig(primaryDir, [
        { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
      ])
      // Remote holds `id`; the load endpoint returns it so warming the cache
      // makes the collision observable without a live per-call fetch.
      fetchMock.mockImplementation((async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? 'GET'
        if (method === 'DELETE') {
          return { ok: true, status: 200, json: async () => ({ id, status: 'retired' }), text: async () => '' } as Response
        }
        if (method === 'GET' && typeof url === 'string' && url.includes(`/engrams/${id}`)) {
          return {
            ok: true, status: 200,
            json: async () => ({ id, scope: 'group:test', status: 'active', data: { statement: 'the remote one' } }),
            text: async () => '',
          } as Response
        }
        return {
          ok: true, status: 200,
          json: async () => ({ rows: [{ id, scope: 'group:test', status: 'active', data: { statement: 'the remote one' } }], total_count: 1 }),
          text: async () => '',
        } as Response
      }) as any)
      seedLocal(id, 'the local one')
      const plur = new Plur({ path: primaryDir })
      await plur.warmRemoteCaches()
      return plur
    }

    it('refuses an unqualified id that exists locally AND on a warmed remote', async () => {
      const plur = await warmedCollision('ENG-COLLIDE-001')

      await expect(plur.forget('ENG-COLLIDE-001')).rejects.toThrow(/Ambiguous engram ID/)

      // and nothing was retired on either side
      expect(deleteCalls().length).toBe(0)
      const local = await plur.getById('ENG-COLLIDE-001')
      expect(local!.status).toBe('active')
    })

    it('scope "primary" retires the local engram and never touches the remote', async () => {
      const plur = await warmedCollision('ENG-COLLIDE-002')

      await plur.forget('ENG-COLLIDE-002', 'local is stale', { scope: 'primary' })

      expect(deleteCalls().length).toBe(0)
      const local = await plur.getById('ENG-COLLIDE-002')
      expect(local!.status).toBe('retired')
    })

    it('an explicit remote scope retires there, leaving the local engram alone', async () => {
      const plur = await warmedCollision('ENG-COLLIDE-003')

      await plur.forget('ENG-COLLIDE-003', 'remote is stale', { scope: 'group:test' })

      expect(deleteCalls().length).toBe(1)
      const local = await plur.getById('ENG-COLLIDE-003')
      expect(local!.status).toBe('active')
    })

    // The hole the #855 audit found: `if (targetScope && targetScope !== 'primary')`
    // fell through when no store matched, and because targetScope was TRUTHY the
    // `if (!targetScope)` ambiguity guard below was skipped entirely. So a typo
    // disabled the guard and restored first-match-wins on exactly the id the
    // guard exists to refuse — reached THROUGH the parameter added to prevent it.
    it('refuses a typo-d scope instead of silently retiring the local engram', async () => {
      const plur = await warmedCollision('ENG-COLLIDE-004')

      // 'group:tset' is a typo of the configured 'group:test'
      await expect(
        plur.forget('ENG-COLLIDE-004', 'oops', { scope: 'group:tset' }),
      ).rejects.toThrow(/no configured store matches that scope/)

      expect(deleteCalls().length).toBe(0)
      const local = await plur.getById('ENG-COLLIDE-004')
      expect(local!.status).toBe('active')
    })

    it('names the valid targets so a typo is correctable from the error alone', async () => {
      const plur = await warmedCollision('ENG-COLLIDE-005')

      await expect(
        plur.forget('ENG-COLLIDE-005', 'oops', { scope: 'group:tset' }),
      ).rejects.toThrow(/group:test/)
    })

    it('accepts a local-family scope as a genuine disambiguation signal', async () => {
      const plur = await warmedCollision('ENG-COLLIDE-006')

      await plur.forget('ENG-COLLIDE-006', 'local is stale', { scope: 'global' })

      expect(deleteCalls().length).toBe(0)
      const local = await plur.getById('ENG-COLLIDE-006')
      expect(local!.status).toBe('retired')
    })

    /**
     * Same collision, but the remote peek cache is never warmed — the state a
     * fresh process is always in. `_loadRemoteCached` is a synchronous peek
     * with no fetch, so the guard used to simply not run here and #831 was
     * reachable unguarded.
     */
    async function coldCollision(id: string) {
      writeStoresConfig(primaryDir, [
        { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
      ])
      fetchMock.mockImplementation((async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? 'GET'
        if (method === 'DELETE') {
          return { ok: true, status: 200, json: async () => ({ id, status: 'retired' }), text: async () => '' } as Response
        }
        if (method === 'GET' && typeof url === 'string' && url.includes(`/engrams/${id}`)) {
          return {
            ok: true, status: 200,
            json: async () => ({ id, scope: 'group:test', status: 'active', data: { statement: 'the remote one' } }),
            text: async () => '',
          } as Response
        }
        // Cold: the bulk load endpoint returns nothing, so the peek stays empty.
        return {
          ok: true, status: 200,
          json: async () => ({ rows: [], total_count: 0 }),
          text: async () => '',
        } as Response
      }) as any)
      seedLocal(id, 'the local one')
      return new Plur({ path: primaryDir })
    }

    it('falls back to a live lookup when the remote cache is cold', async () => {
      const plur = await coldCollision('ENG-COLD-001')

      await expect(plur.forget('ENG-COLD-001')).rejects.toThrow(/Ambiguous engram ID/)

      expect(deleteCalls().length).toBe(0)
      const local = await plur.getById('ENG-COLD-001')
      expect(local!.status).toBe('active')
    })

    it('scope "primary" skips the live lookup entirely on a cold cache', async () => {
      const plur = await coldCollision('ENG-COLD-002')

      await plur.forget('ENG-COLD-002', 'local is stale', { scope: 'primary' })

      expect(deleteCalls().length).toBe(0)
      const local = await plur.getById('ENG-COLD-002')
      expect(local!.status).toBe('retired')
    })

    it('refuses rather than guessing when the remote cannot be reached to rule out a collision', async () => {
      writeStoresConfig(primaryDir, [
        { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
      ])
      fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
        if ((init?.method ?? 'GET') === 'GET') throw new Error('network down')
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response
      }) as any)
      seedLocal('ENG-COLD-003', 'the local one')
      const plur = new Plur({ path: primaryDir })

      await expect(plur.forget('ENG-COLD-003')).rejects.toThrow(/could not be reached/)

      const local = await plur.getById('ENG-COLD-003')
      expect(local!.status).toBe('active')
    })

    // The MCP layer's `Already retired` short-circuit depends on a prior
    // getById that an explicitly-scoped forget deliberately skips, so core has
    // to be idempotent on its own account. History is the audit trail for a
    // destructive irreversible operation — a second call must not append a
    // second `engram_retired` for the same engram.
    it('is idempotent — a second scoped forget does not re-retire or re-log', async () => {
      const plur = await warmedCollision('ENG-COLLIDE-007')

      await plur.forget('ENG-COLLIDE-007', 'first', { scope: 'primary' })
      await plur.forget('ENG-COLLIDE-007', 'second', { scope: 'primary' })

      // History is bucketed per month: {root}/history/YYYY-MM.jsonl
      const historyDir = join(primaryDir, 'history')
      const events = readdirSync(historyDir)
        .filter(f => f.endsWith('.jsonl'))
        .flatMap(f => readFileSync(join(historyDir, f), 'utf8').split('\n').filter(Boolean))
        .map(l => JSON.parse(l))
        .filter(e => e.engram_id === 'ENG-COLLIDE-007' && e.event === 'engram_retired')
      expect(events.length).toBe(1)
    })
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

  // #1109 — a namespaced ID (ENG-GTE-...) unambiguously identifies one store.
  // forget() must strip the prefix and DELETE the server-side id from that store.
  // storePrefix('group:test') === 'GTE'.
  it('forget(namespaced-id) strips prefix and deletes from the correct remote', async () => {
    const serverId = 'ENG-2026-09-01-036'
    const namespaced = 'ENG-GTE-2026-09-01-036'

    fetchMock.mockImplementation((async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && typeof url === 'string' && url.includes(`/engrams/${serverId}`)) {
        return {
          ok: true, status: 200,
          json: async () => ({ id: serverId, scope: 'group:test', status: 'active', data: { statement: 'remote engram' } }),
          text: async () => '',
        } as Response
      }
      if (method === 'DELETE' && typeof url === 'string' && url.includes(`/engrams/${serverId}`)) {
        return {
          ok: true, status: 200,
          json: async () => ({ id: serverId, status: 'retired' }),
          text: async () => '',
        } as Response
      }
      return {
        ok: true, status: 200,
        json: async () => ({ rows: [], total_count: 0 }),
        text: async () => '',
      } as Response
    }) as any)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    await plur.forget(namespaced, 'no longer needed')

    const dels = deleteCalls()
    expect(dels.length).toBe(1)
    // The DELETE hits the bare server-side id, not the namespaced caller-facing id.
    expect(dels[0][0]).toContain(`/engrams/${serverId}`)
    expect(dels[0][0]).not.toContain('GTE')
  })

  // #1109 — when the target store is unreachable (expired token, network down)
  // and the id is namespaced, forget() must throw an actionable error naming the
  // scope and the escape hatch — NOT the generic "Engram not found" that leaves
  // the caller with no path forward.
  it('forget(namespaced-id) with unreachable remote throws actionable error, not "Engram not found"', async () => {
    const namespaced = 'ENG-GTE-2026-09-01-099'

    fetchMock.mockImplementation((async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:443')
    }) as any)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    // Must throw with the scope name so the caller knows where to retry.
    await expect(plur.forget(namespaced)).rejects.toThrow(/Cannot reach/)
    await expect(plur.forget(namespaced)).rejects.toThrow(/group:test/)
    // Must NOT emit the generic "Engram not found" — that implies absence,
    // which was never verified when the store was unreachable.
    await expect(plur.forget(namespaced)).rejects.not.toThrow(/^Engram not found/)
  })
})

/**
 * Issue #85 — feedback() must route to remote stores when the engram
 * is not found locally. Sends the signal to the server via
 * POST /api/v1/engrams/:id/feedback; server owns the mutation logic.
 */
describe('feedback() — remote routing (issue #85)', () => {
  let primaryDir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'plur-feedback-'))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(primaryDir, { recursive: true, force: true })
  })

  function feedbackPostCalls() {
    return fetchMock.mock.calls.filter(
      ([url, init]) => (init as any)?.method === 'POST' && typeof url === 'string' && url.includes('/feedback'),
    )
  }

  function mockRemoteWithFeedback(id: string) {
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
      // POST /engrams/:id/feedback — success
      if (method === 'POST' && typeof url === 'string' && url.includes(`/engrams/${id}/feedback`)) {
        return { ok: true, status: 200, json: async () => ({ success: true }), text: async () => '' } as Response
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

  it('feedback routes to remote for server-assigned ID', async () => {
    mockRemoteWithFeedback('ENG-REMOTE-FB-001')

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    await plur.feedback('ENG-REMOTE-FB-001', 'positive')

    const posts = feedbackPostCalls()
    expect(posts.length).toBe(1)
    expect(posts[0][0]).toContain('/engrams/ENG-REMOTE-FB-001/feedback')
    const body = JSON.parse((posts[0][1] as any).body)
    expect(body.signal).toBe('positive')
  })

  it('feedback logs history with routed_to: remote', async () => {
    mockRemoteWithFeedback('ENG-REMOTE-FB-002')

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    await plur.feedback('ENG-REMOTE-FB-002', 'negative')

    const historyDir = join(primaryDir, 'history')
    const files = existsSync(historyDir) ? readdirSync(historyDir).filter(f => f.endsWith('.jsonl')) : []
    expect(files.length).toBeGreaterThan(0)

    const historyContent = readFileSync(join(historyDir, files[0]), 'utf-8')
    expect(historyContent).toContain('feedback_received')
    expect(historyContent).toContain('ENG-REMOTE-FB-002')
    expect(historyContent).toContain('remote')
  })

  it('feedback prefers local over remote', async () => {
    mockRemoteWithFeedback('ENG-LOCAL-FB-001')

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    const engram = await plur.learn('local engram for feedback', { scope: 'global' })
    await plur.feedback(engram.id, 'positive')

    // No feedback POST to remote
    const posts = feedbackPostCalls()
    expect(posts.length).toBe(0)

    // Local engram was updated
    const found = await plur.getById(engram.id)
    expect(found!.feedback_signals?.positive).toBe(1)
  })

  it('feedback on readonly remote throws', async () => {
    mockRemoteWithFeedback('ENG-READONLY-FB-001')

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: true },
    ])
    const plur = new Plur({ path: primaryDir })

    await expect(plur.feedback('ENG-READONLY-FB-001', 'positive')).rejects.toThrow('readonly store')
  })

  it('feedback throws when engram not in local or remote', async () => {
    // Remote getById returns null
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

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    await expect(plur.feedback('ENG-NONEXISTENT-001', 'positive')).rejects.toThrow('Engram not found')
  })

  it('feedback surfaces server error clearly', async () => {
    // getById succeeds but feedback POST fails
    fetchMock.mockImplementation((async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && typeof url === 'string' && url.includes('/engrams/ENG-SRV-ERR')) {
        return {
          ok: true, status: 200,
          json: async () => ({ id: 'ENG-SRV-ERR', scope: 'group:test', status: 'active', data: { statement: 'test' } }),
          text: async () => '',
        } as Response
      }
      if (method === 'POST' && typeof url === 'string' && url.includes('/feedback')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'internal server error' } as Response
      }
      return {
        ok: true, status: 200,
        json: async () => ({ rows: [], total_count: 0 }),
        text: async () => '',
      } as Response
    }) as any)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    await expect(plur.feedback('ENG-SRV-ERR', 'positive')).rejects.toThrow('Remote feedback failed')
  })
})

/**
 * Issue #850 — plur_feedback must refuse with an error (not silently pick
 * one) when the same bare ID exists in both the local primary store and a
 * warmed remote cache. A scope parameter lets callers route explicitly.
 */
describe('feedback() — cross-store ID collision guard (issue #850)', () => {
  let primaryDir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'plur-850-'))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(primaryDir, { recursive: true, force: true })
  })

  function mockRemoteWithId(id: string) {
    fetchMock.mockImplementation((async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      // GET /engrams/:id — found (used for scope-targeted routing)
      if (method === 'GET' && typeof url === 'string' && url.includes(`/engrams/${id}`)) {
        return {
          ok: true, status: 200,
          json: async () => ({ id, scope: 'group:test', status: 'active', data: { statement: 'remote engram' } }),
          text: async () => '',
        } as Response
      }
      // POST /engrams/:id/feedback — success
      if (method === 'POST' && typeof url === 'string' && url.includes(`/engrams/${id}/feedback`)) {
        return { ok: true, status: 200, json: async () => ({ success: true }), text: async () => '' } as Response
      }
      // GET /engrams?scope=... (load / warm cache) — return the colliding engram
      if (method === 'GET' && typeof url === 'string' && url.includes('engrams')) {
        return {
          ok: true, status: 200,
          json: async () => ({ rows: [{ id, scope: 'group:test', status: 'active', data: { statement: 'remote engram' } }], total_count: 1 }),
          text: async () => '',
        } as Response
      }
      return { ok: false, status: 404, text: async () => 'not found' } as Response
    }) as any)
  }

  it('throws on bare-ID collision when remote cache is warmed', async () => {
    const collidingId = 'ENG-2026-08-09-002'
    mockRemoteWithId(collidingId)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    // Learn locally — creates the same ID in the primary store
    // (We inject it directly to simulate the collision without minting the same ID)
    const localEngram = await plur.learn('local engram with colliding id', { scope: 'global' })
    // Override the ID to simulate a collision with the remote
    const yaml_ = await import('js-yaml')
    const engramPath = join(primaryDir, 'engrams.yaml')
    const content = readFileSync(engramPath, 'utf-8')
    const data = yaml_.load(content) as { engrams: Array<{ id: string }> }
    data.engrams.find(e => e.id === localEngram.id)!.id = collidingId
    writeFileSync(engramPath, yaml_.dump(data))

    // Warm the remote cache so the collision is visible
    await plur.warmRemoteCaches()

    // Without scope: must refuse, not pick silently
    await expect(plur.feedback(collidingId, 'positive')).rejects.toThrow(/Ambiguous engram ID/)
  })

  it('scope: "primary" routes to local store, skips remote', async () => {
    const collidingId = 'ENG-2026-08-09-003'
    mockRemoteWithId(collidingId)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    // Inject the colliding ID into the primary store
    const localEngram = await plur.learn('local engram for scope test', { scope: 'global' })
    const yaml_ = await import('js-yaml')
    const engramPath = join(primaryDir, 'engrams.yaml')
    const content = readFileSync(engramPath, 'utf-8')
    const data = yaml_.load(content) as { engrams: Array<{ id: string }> }
    data.engrams.find(e => e.id === localEngram.id)!.id = collidingId
    writeFileSync(engramPath, yaml_.dump(data))

    await plur.warmRemoteCaches()

    // With scope: "primary" — must succeed and NOT call remote
    await plur.feedback(collidingId, 'positive', 'primary')
    const posts = fetchMock.mock.calls.filter(
      // `mock.calls` is any[][]; a fixed-length tuple is not assignable to it,
      // which is what broke `typecheck:tests`. Destructure untyped and guard
      // with `typeof`, as the rest of this file does.
      ([url, init]) =>
        (init as any)?.method === 'POST' && typeof url === 'string' && url.includes('/feedback'),
    )
    expect(posts.length).toBe(0)
  })

  it('scope: <remote-scope> routes to remote, skips local', async () => {
    const collidingId = 'ENG-2026-08-09-004'
    mockRemoteWithId(collidingId)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })

    // Inject the colliding ID into the primary store
    const localEngram = await plur.learn('local engram for remote-scope test', { scope: 'global' })
    const yaml_ = await import('js-yaml')
    const engramPath = join(primaryDir, 'engrams.yaml')
    const content = readFileSync(engramPath, 'utf-8')
    const data = yaml_.load(content) as { engrams: Array<{ id: string }> }
    data.engrams.find(e => e.id === localEngram.id)!.id = collidingId
    writeFileSync(engramPath, yaml_.dump(data))

    // With scope: "group:test" — must POST to remote
    await plur.feedback(collidingId, 'negative', 'group:test')
    const posts = fetchMock.mock.calls.filter(
      // `mock.calls` is any[][]; a fixed-length tuple is not assignable to it,
      // which is what broke `typecheck:tests`. Destructure untyped and guard
      // with `typeof`, as the rest of this file does.
      ([url, init]) =>
        (init as any)?.method === 'POST' && typeof url === 'string' && url.includes('/feedback'),
    )
    expect(posts.length).toBe(1)
    expect(posts[0][0]).toContain(`/engrams/${collidingId}/feedback`)
  })

  /** Seed a local engram carrying a chosen (colliding) id. */
  async function seedCollidingLocal(plur: Plur, collidingId: string, statement: string) {
    const localEngram = await plur.learn(statement, { scope: 'global' })
    const yaml_ = await import('js-yaml')
    const engramPath = join(primaryDir, 'engrams.yaml')
    const data = yaml_.load(readFileSync(engramPath, 'utf-8')) as { engrams: Array<{ id: string }> }
    data.engrams.find(e => e.id === localEngram.id)!.id = collidingId
    writeFileSync(engramPath, yaml_.dump(data))
  }

  // Was 'does not throw when remote cache is cold (backward compatible)'.
  // That backward compatibility WAS the hole: `_loadRemoteCached` is a
  // synchronous peek with no fetch, so on a fresh process the guard did not
  // run and first-match-wins was restored — silently, in the case the guard
  // exists for. It now falls back to a live probe when the cache is cold.
  it('detects the collision on a cold cache via a live probe', async () => {
    const collidingId = 'ENG-2026-08-09-005'
    mockRemoteWithId(collidingId)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    await seedCollidingLocal(plur, collidingId, 'local engram cold cache test')

    // Cache deliberately NOT warmed.
    await expect(plur.feedback(collidingId, 'positive')).rejects.toThrow(/Ambiguous engram ID/)
  })

  // The #851 audit: `if (scope && scope !== 'primary')` fell through when no
  // store matched, and because `scope` was truthy the `if (!scope)` ambiguity
  // guard was skipped — so a typo silently restored first-match-wins.
  it('refuses a typo-d scope instead of silently rating the local engram', async () => {
    const collidingId = 'ENG-2026-08-09-006'
    mockRemoteWithId(collidingId)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    await seedCollidingLocal(plur, collidingId, 'local engram typo scope test')

    // 'group:tset' is a typo of the configured 'group:test'
    await expect(plur.feedback(collidingId, 'positive', 'group:tset'))
      .rejects.toThrow(/no configured store matches that scope/)
  })

  it('names the valid targets so a typo is correctable from the error alone', async () => {
    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    const e = await plur.learn('local engram for target listing', { scope: 'global' })

    await expect(plur.feedback(e.id, 'positive', 'group:tset')).rejects.toThrow(/group:test/)
  })

  // Deliberately WEAKER than forget()'s equivalent. A mis-targeted feedback
  // signal is recoverable and rating is a hot path, so an unreachable store
  // warns and proceeds rather than blocking the write — where forget() refuses.
  it('rates locally with a warning when the remote cannot be reached to rule out a collision', async () => {
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'GET') throw new Error('network down')
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response
    }) as any)

    writeStoresConfig(primaryDir, [
      { url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false },
    ])
    const plur = new Plur({ path: primaryDir })
    const e = await plur.learn('local engram unreachable remote', { scope: 'global' })

    await expect(plur.feedback(e.id, 'positive')).resolves.toBeUndefined()
  })
})
