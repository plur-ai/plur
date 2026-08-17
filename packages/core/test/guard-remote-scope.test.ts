/**
 * Remote-backed (non-shared) leak guard.
 *
 * The write-time leak guard originally only fired for `isSharedScope`-prefixed
 * scopes (group:/project:/space:/team:/org:/public). But a scope can be PERSONAL
 * by prefix (`user:plur:gregor`) yet still be backed by a REMOTE store (a config
 * entry with a `url` → data goes to plur.datafund.io). Such a write is NOT
 * `isSharedScope`, so sensitive content used to bypass the guard and reach the
 * remote unguarded. The real risk is "does the data leave the machine", i.e. the
 * scope routes to a remote store.
 *
 * `_isRemoteBackedScope` closes that gap: the guard now fires for shared OR
 * remote-backed scopes. These tests pin:
 *   (a) sensitive write to a remote `user:` scope is DEMOTED to local, 0 appends.
 *   (b) a CLEAN write to that same remote `user:` scope IS appended (not over-blocked).
 *   (c) `global` (no store) + sensitive content stays personal (unchanged).
 *   (d) a local-FILE store (path, no url) that is isSharedScope by prefix still
 *       demotes on sensitive (unchanged existing behavior).
 *   (e) per-scope `sensitivity.allow` policy is still honored on a remote scope.
 *
 * Harness mirrors guard-remote-boundary.test.ts: a vi.fn() over globalThis.fetch
 * asserting on POST (append) calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

// A PERSONAL-prefix scope (NOT isSharedScope) that is nonetheless remote-backed.
const REMOTE_USER_SCOPE = 'user:plur:gregor'
const REMOTE_URL = 'https://plur.example.com/sse'
// A real (public) droplet-shaped IPv4 — the exact shape that leaked in 2026-06.
const PUBLIC_IP = '139.59.155.82'

function writeStoresConfig(dir: string, stores: Array<Record<string, unknown>>) {
  writeFileSync(
    join(dir, 'config.yaml'),
    yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }),
  )
}

/** A writable remote store for the personal `user:` scope. */
function remoteUserStore(extra: Record<string, unknown> = {}) {
  return [{
    url: REMOTE_URL,
    token: 'plur_sk_test',
    scope: REMOTE_USER_SCOPE,
    readonly: false,
    ...extra,
  }]
}

function readLocalEngrams(dir: string): any[] {
  const path = join(dir, 'engrams.yaml')
  if (!existsSync(path)) return []
  const data = yaml.load(readFileSync(path, 'utf-8')) as { engrams?: unknown[] } | null
  return (data?.engrams ?? []) as any[]
}

describe('remote-backed (non-shared) leak guard', () => {
  let dir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-guard-remote-scope-'))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  function postCalls() {
    return fetchMock.mock.calls.filter(([, init]) => (init as any)?.method === 'POST')
  }

  /** Empty-list mock for the load() page-walk; POST append succeeds. */
  function mockEmptyRemote() {
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ id: 'ENG-REMOTE-001' }), text: async () => '' } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    }) as any)
  }

  // (a) The new coverage: a public-IP statement learned to a REMOTE-backed but
  // PERSONAL-prefix scope (`user:plur:gregor`) must be demoted to local and must
  // NOT reach the remote (0 appends) — exactly the gap _isRemoteBackedScope fixes.
  it('(a) sensitive write to a remote user: scope is demoted to local, never appended', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, remoteUserStore())
    const plur = new Plur({ path: dir })

    const engram = plur.learn(`my prod box is ${PUBLIC_IP}`, {
      scope: REMOTE_USER_SCOPE,
      type: 'behavioral',
    }) as { scope: string; visibility: string }

    // Demoted at the guard — stays on the machine.
    expect(engram.scope).toBe('local')
    expect(engram.visibility).toBe('private')

    // Give any (erroneous) fire-and-forget push time to fire.
    await new Promise(r => setTimeout(r, 50))

    // The remote append spy saw ZERO engrams, and nothing queued for retry.
    expect(postCalls().length).toBe(0)
    expect(plur.outboxCount()).toBe(0)

    // Kept locally (demoted), not lost.
    const local = readLocalEngrams(dir)
    expect(local.find(e => e.scope === 'local' && String(e.statement).includes(PUBLIC_IP))).toBeDefined()
  })

  // (b) A CLEAN write to the SAME remote user: scope is NOT demoted and DOES reach
  // the remote — proves the guard is not over-blocking the personal remote scope.
  it('(b) clean write to a remote user: scope is not demoted and reaches the remote', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, remoteUserStore())
    const plur = new Plur({ path: dir })

    const engram = plur.learn('I prefer concise commit messages', {
      scope: REMOTE_USER_SCOPE,
      type: 'preference',
    }) as { scope: string }

    // Not demoted — scope honored.
    expect(engram.scope).toBe(REMOTE_USER_SCOPE)

    // Let the fire-and-forget push settle.
    await new Promise(r => setTimeout(r, 50))

    // The clean engram WAS appended to the remote.
    expect(postCalls().length).toBe(1)
  })

  // (c) `global` is a PERSONAL local scope with NO store backing — it must stay
  // exempt. Sensitive content here is NOT demoted (global stays personal/local).
  it('(c) sensitive write to global (no store) is not demoted', () => {
    // No stores at all → global is neither shared nor remote-backed.
    writeStoresConfig(dir, [])
    const plur = new Plur({ path: dir })

    const engram = plur.learn(`my home server is ${PUBLIC_IP}`, {
      scope: 'global',
      type: 'behavioral',
    }) as { scope: string }

    expect(engram.scope).toBe('global')
  })

  // (d) A local-FILE store (path, no url) at a shared-prefix scope still demotes
  // on sensitive content — unchanged existing isSharedScope behavior. Confirms the
  // change only ADDS remote-backed coverage, it does not alter shared-prefix paths.
  it('(d) sensitive write to a local-file shared-prefix store still demotes', () => {
    const filePath = join(dir, 'team-store.yaml')
    writeStoresConfig(dir, [{
      path: filePath,
      scope: 'project:plur',   // isSharedScope by prefix, but LOCAL file (no url)
      readonly: false,
    }])
    const plur = new Plur({ path: dir })

    const engram = plur.learn(`the deploy target is ${PUBLIC_IP}`, {
      scope: 'project:plur',
      type: 'behavioral',
    }) as { scope: string; visibility: string }

    // Demoted exactly as before — shared prefix path unchanged.
    expect(engram.scope).toBe('local')
    expect(engram.visibility).toBe('private')
  })

  // (e) Per-scope policy is still honored on a remote-backed scope: when the
  // scope's `sensitivity.allow` includes the matched category, the write is NOT
  // demoted (it reaches the remote). Proves the new gate flows into the SAME
  // per-scope policy as shared scopes.
  it('(e) remote user: scope with sensitivity.allow:[infra] is not demoted on an infra hit', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, remoteUserStore({
      description: 'my personal remote namespace',
      sensitivity: { forbid: ['secrets'], allow: ['infra'] },
    }))
    const plur = new Plur({ path: dir })

    const engram = plur.learn(`my prod box is ${PUBLIC_IP}`, {
      scope: REMOTE_USER_SCOPE,
      type: 'behavioral',
    }) as { scope: string }

    // The infra hit is explicitly allowed by this scope's policy → not demoted.
    expect(engram.scope).toBe(REMOTE_USER_SCOPE)

    await new Promise(r => setTimeout(r, 50))
    // And it reached the remote.
    expect(postCalls().length).toBe(1)
  })
})
