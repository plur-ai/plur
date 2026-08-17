import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
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

function readLocalEngrams(dir: string): any[] {
  const path = join(dir, 'engrams.yaml')
  if (!existsSync(path)) return []
  const data = yaml.load(readFileSync(path, 'utf-8')) as { engrams?: unknown[] } | null
  return (data?.engrams ?? []) as any[]
}

const REMOTE_SCOPE = 'group:plur/plur-ai/engineering'
const REMOTE_URL = 'https://plur.example.com/sse'

function storeConfig() {
  return [{
    url: REMOTE_URL,
    token: 'plur_sk_test',
    scope: REMOTE_SCOPE,
    shared: true,
    readonly: false,
  }]
}

describe('outbox pattern (issue #26)', () => {
  let primaryDir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'plur-outbox-'))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(primaryDir, { recursive: true, force: true })
  })

  function mockRemoteFailure(errorMsg = 'Network error') {
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        throw new Error(errorMsg)
      }
      return {
        ok: true, status: 200,
        json: async () => ({ rows: [], total_count: 0 }),
        text: async () => '',
      } as Response
    }) as any)
  }

  function mockRemoteSuccess() {
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
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

  it('learn() saves locally with _outbox metadata when remote fails', async () => {
    mockRemoteFailure('connection refused')
    writeStoresConfig(primaryDir, storeConfig())
    const plur = new Plur({ path: primaryDir })

    const engram = plur.learn('outbox test engram', {
      scope: REMOTE_SCOPE,
      type: 'behavioral',
    })

    expect(engram.statement).toBe('outbox test engram')
    expect(engram.scope).toBe(REMOTE_SCOPE)

    // Wait for async fire-and-forget to settle
    await new Promise(r => setTimeout(r, 50))

    // Engram should be in local store with outbox metadata
    const local = readLocalEngrams(primaryDir)
    const outboxEngram = local.find((e: any) => e.statement === 'outbox test engram')
    expect(outboxEngram).toBeDefined()
    expect(outboxEngram.structured_data._outbox).toBeDefined()
    expect(outboxEngram.structured_data._outbox.target_url).toBe(REMOTE_URL)
    expect(outboxEngram.structured_data._outbox.target_scope).toBe(REMOTE_SCOPE)
    expect(outboxEngram.structured_data._outbox.last_error).toBe('connection refused')
    expect(outboxEngram.structured_data._outbox.attempt_count).toBe(1)
  })

  it('learn() removes local copy on successful immediate push', async () => {
    mockRemoteSuccess()
    writeStoresConfig(primaryDir, storeConfig())
    const plur = new Plur({ path: primaryDir })

    plur.learn('success test engram', {
      scope: REMOTE_SCOPE,
      type: 'behavioral',
    })

    // Wait for async push + cleanup
    await new Promise(r => setTimeout(r, 100))

    // Local store should NOT contain the engram (removed after success)
    const local = readLocalEngrams(primaryDir)
    const found = local.find((e: any) => e.statement === 'success test engram')
    expect(found).toBeUndefined()
  })

  it('learnRouted() saves to outbox on remote failure instead of throwing', async () => {
    mockRemoteFailure('server error')
    writeStoresConfig(primaryDir, storeConfig())
    const plur = new Plur({ path: primaryDir })

    // Should NOT throw — should save to outbox
    const engram = await plur.learnRouted('routed outbox test', {
      scope: REMOTE_SCOPE,
      type: 'procedural',
    })

    expect(engram.statement).toBe('routed outbox test')
    expect((engram as any).structured_data._outbox).toBeDefined()
    expect((engram as any).structured_data._outbox.attempt_count).toBe(1)
    expect((engram as any).structured_data._outbox.last_error).toBe('server error')

    // Should be in local store
    const local = readLocalEngrams(primaryDir)
    const found = local.find((e: any) => e.statement === 'routed outbox test')
    expect(found).toBeDefined()
    expect(found.structured_data._outbox).toBeDefined()
  })

  it('flushOutbox() pushes pending engrams and removes on success', async () => {
    // First: create an outbox entry via failed remote write
    mockRemoteFailure()
    writeStoresConfig(primaryDir, storeConfig())
    const plur = new Plur({ path: primaryDir })

    await plur.learnRouted('flush test engram', {
      scope: REMOTE_SCOPE,
      type: 'behavioral',
    })

    // Verify it's in the outbox
    expect(plur.outboxCount()).toBe(1)

    // Now mock success and flush
    mockRemoteSuccess()
    const result = await plur.flushOutbox()

    expect(result.flushed).toBe(1)
    expect(result.failed).toBe(0)
    expect(plur.outboxCount()).toBe(0)

    // Local store should not contain it anymore
    const local = readLocalEngrams(primaryDir)
    const found = local.find((e: any) => e.statement === 'flush test engram')
    expect(found).toBeUndefined()
  })

  it('flushOutbox() updates attempt_count on continued failure', async () => {
    mockRemoteFailure('still down')
    writeStoresConfig(primaryDir, storeConfig())
    const plur = new Plur({ path: primaryDir })

    await plur.learnRouted('retry test', {
      scope: REMOTE_SCOPE,
      type: 'behavioral',
    })

    // Flush with remote still down
    const result = await plur.flushOutbox()
    expect(result.flushed).toBe(0)
    expect(result.failed).toBe(1)
    expect(plur.outboxCount()).toBe(1)

    // Check attempt_count incremented
    const local = readLocalEngrams(primaryDir)
    const found = local.find((e: any) => e.statement === 'retry test')
    expect(found.structured_data._outbox.attempt_count).toBe(2) // 1 from learnRouted + 1 from flush
    expect(found.structured_data._outbox.last_error).toBe('still down')
  })

  it('flushOutbox() warns on entries older than 7 days', async () => {
    mockRemoteFailure()
    writeStoresConfig(primaryDir, storeConfig())
    const plur = new Plur({ path: primaryDir })

    await plur.learnRouted('old engram', {
      scope: REMOTE_SCOPE,
      type: 'behavioral',
    })

    // Manually backdate the outbox entry
    const local = readLocalEngrams(primaryDir)
    const found = local.find((e: any) => e.statement === 'old engram')
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    found.structured_data._outbox.queued_at = eightDaysAgo
    writeFileSync(
      join(primaryDir, 'engrams.yaml'),
      yaml.dump({ engrams: local }, { lineWidth: 120, noRefs: true }),
    )

    const result = await plur.flushOutbox()
    expect(result.expired_warnings.length).toBeGreaterThan(0)
    expect(result.expired_warnings[0]).toContain('8d ago')
  })

  it('outboxCount() returns correct count', async () => {
    mockRemoteFailure()
    writeStoresConfig(primaryDir, storeConfig())
    const plur = new Plur({ path: primaryDir })

    expect(plur.outboxCount()).toBe(0)

    await plur.learnRouted('count test 1', { scope: REMOTE_SCOPE })
    expect(plur.outboxCount()).toBe(1)

    await plur.learnRouted('count test 2', { scope: REMOTE_SCOPE })
    expect(plur.outboxCount()).toBe(2)
  })

  it('status().outbox_count reflects pending entries', async () => {
    mockRemoteFailure()
    writeStoresConfig(primaryDir, storeConfig())
    const plur = new Plur({ path: primaryDir })

    expect(plur.status().outbox_count).toBe(0)

    await plur.learnRouted('status test', { scope: REMOTE_SCOPE })
    expect(plur.status().outbox_count).toBe(1)
  })

  it('flushOutbox() returns clean result when no pending entries', async () => {
    writeStoresConfig(primaryDir, storeConfig())
    mockRemoteSuccess()
    const plur = new Plur({ path: primaryDir })

    const result = await plur.flushOutbox()
    expect(result.flushed).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.expired_warnings).toEqual([])
  })

  it('hash dedup prevents duplicate outbox entries', async () => {
    mockRemoteFailure()
    writeStoresConfig(primaryDir, storeConfig())
    const plur = new Plur({ path: primaryDir })

    await plur.learnRouted('dedup test', { scope: REMOTE_SCOPE })
    const first = plur.outboxCount()

    // Same statement should be deduped
    await plur.learnRouted('dedup test', { scope: REMOTE_SCOPE })
    expect(plur.outboxCount()).toBe(first)
  })

  // R2-D (#12): flushOutbox re-runs the leak guard against the target scope's
  // CURRENT policy before re-pushing. An _outbox marker is only stamped after
  // the write-time guard passed, but that verdict can go stale: if the scope's
  // `sensitivity.forbid` is tightened between queue-time and flush-time, a
  // now-offending engram must be demoted in place, NOT pushed to the shared
  // remote unguarded.
  it('flushOutbox() re-guards: a scope policy tightened after queue-time demotes instead of pushing', async () => {
    // Queue-time policy: forbid infra BUT explicitly allow it, so an infra-
    // bearing statement is clean-for-the-old-policy and queues on remote failure.
    mockRemoteFailure('down at queue time')
    const PUBLIC_IP = '139.59.155.82' // real droplet IPv4 → infra detector hit
    writeStoresConfig(primaryDir, [{
      url: REMOTE_URL, token: 'plur_sk_test', scope: REMOTE_SCOPE, shared: true, readonly: false,
      sensitivity: { forbid: ['infra'], allow: ['infra'] }, // infra allowed at queue-time
    }])
    const plur = new Plur({ path: primaryDir })

    await plur.learnRouted(`prod box is at ${PUBLIC_IP}`, { scope: REMOTE_SCOPE, type: 'procedural' })
    expect(plur.outboxCount()).toBe(1) // queued (clean under the old policy)

    // Tighten the policy: forbid infra, NO allow. Fresh Plur picks up the edit.
    writeStoresConfig(primaryDir, [{
      url: REMOTE_URL, token: 'plur_sk_test', scope: REMOTE_SCOPE, shared: true, readonly: false,
      sensitivity: { forbid: ['infra'] }, // infra now forbidden
    }])
    const plur2 = new Plur({ path: primaryDir })

    // Remote is UP now — but the re-guard must hold the engram back anyway.
    mockRemoteSuccess()
    const pushSpy = vi.fn()
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') { pushSpy(); return { ok: true, status: 201, json: async () => ({ id: 'X' }), text: async () => '' } as Response }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    }) as any)

    const result = await plur2.flushOutbox()
    // NOT flushed (held back), counted as failed, and never POSTed to the remote.
    expect(result.flushed).toBe(0)
    expect(result.failed).toBe(1)
    expect(pushSpy).not.toHaveBeenCalled()
    expect(result.expired_warnings.some(w => /demoted to local\/private|now forbidden/.test(w))).toBe(true)

    // Engram demoted in place: scope→local, _outbox dropped, _demoted stamped.
    const local = readLocalEngrams(primaryDir)
    const found = local.find((e: any) => e.statement.includes(PUBLIC_IP))
    expect(found).toBeDefined()
    expect(found.scope).toBe('local')
    expect(found.visibility).toBe('private')
    expect(found.structured_data?._outbox).toBeUndefined()
    expect(found.structured_data?._demoted?.to).toBe('local')
  })

  // #405: the flush re-guard must scan the `domain` field too. `domain` IS sent
  // to the remote API, and at learn-time it is already scanned (it rides in the
  // LearnContext); the reconstruct-from-engram path (`_engramContextFields`) used
  // by the flush re-guard previously OMITTED it, so a host:port / IP placed in
  // `domain` could ride to a shared store on flush. Statement is clean here — the
  // infra lives ONLY in `domain`.
  it('flushOutbox() re-guards the domain field: infra in `domain` is demoted, not pushed (#405)', async () => {
    mockRemoteFailure('down at queue time')
    const PUBLIC_IP = '139.59.155.82' // real droplet IPv4 → infra detector hit
    // Queue-time policy allows infra, so the infra-bearing domain queues clean.
    writeStoresConfig(primaryDir, [{
      url: REMOTE_URL, token: 'plur_sk_test', scope: REMOTE_SCOPE, shared: true, readonly: false,
      sensitivity: { forbid: ['infra'], allow: ['infra'] },
    }])
    const plur = new Plur({ path: primaryDir })

    await plur.learnRouted('routine team note', { scope: REMOTE_SCOPE, type: 'procedural', domain: `prod ${PUBLIC_IP}` })
    expect(plur.outboxCount()).toBe(1) // queued (clean under the old policy)

    // Tighten: forbid infra, no allow. Fresh Plur picks up the edit.
    writeStoresConfig(primaryDir, [{
      url: REMOTE_URL, token: 'plur_sk_test', scope: REMOTE_SCOPE, shared: true, readonly: false,
      sensitivity: { forbid: ['infra'] },
    }])
    const plur2 = new Plur({ path: primaryDir })

    mockRemoteSuccess()
    const pushSpy = vi.fn()
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') { pushSpy(); return { ok: true, status: 201, json: async () => ({ id: 'X' }), text: async () => '' } as Response }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    }) as any)

    const result = await plur2.flushOutbox()
    // Held back via the domain scan: not flushed, counted failed, never POSTed.
    expect(result.flushed).toBe(0)
    expect(result.failed).toBe(1)
    expect(pushSpy).not.toHaveBeenCalled()

    // Demoted in place: scope→local, visibility→private, _outbox dropped.
    const local = readLocalEngrams(primaryDir)
    const found = local.find((e: any) => e.domain === `prod ${PUBLIC_IP}`)
    expect(found).toBeDefined()
    expect(found.scope).toBe('local')
    expect(found.visibility).toBe('private')
    expect(found.structured_data?._outbox).toBeUndefined()
  })

  // BOUNDARY: an engram that is STILL clean under the current policy flushes
  // normally — the re-guard must not over-block.
  it('flushOutbox() still pushes when the engram is clean under the current policy', async () => {
    mockRemoteFailure()
    writeStoresConfig(primaryDir, storeConfig())
    const plur = new Plur({ path: primaryDir })
    await plur.learnRouted('a perfectly clean team note', { scope: REMOTE_SCOPE, type: 'behavioral' })
    expect(plur.outboxCount()).toBe(1)

    mockRemoteSuccess()
    const result = await plur.flushOutbox()
    expect(result.flushed).toBe(1)
    expect(result.failed).toBe(0)
    expect(plur.outboxCount()).toBe(0)
  })

  it('flushOutbox() warns when remote store no longer configured', async () => {
    mockRemoteFailure()
    writeStoresConfig(primaryDir, storeConfig())
    const plur = new Plur({ path: primaryDir })

    await plur.learnRouted('orphaned engram', { scope: REMOTE_SCOPE })

    // Remove the remote store from config
    writeStoresConfig(primaryDir, [])
    // Need a fresh Plur instance to pick up the config change
    const plur2 = new Plur({ path: primaryDir })

    const result = await plur2.flushOutbox()
    expect(result.failed).toBe(1)
    expect(result.expired_warnings.some(w => w.includes('no matching remote store'))).toBe(true)
  })
})
