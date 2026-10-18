/**
 * Decisions E4 (config) and E5 (fold), owner 2026-09-26 — the local-family
 * predicate `isLocalOnlyScope` (scope-target.ts).
 *
 *  - E5: it case-folds like `isSharedScope`.
 *  - E4: `project:*` is local-only only if no configured URL store's scope
 *    equals or segment-contains it (the `isScopeWithin` rule). The stores are
 *    threaded to the callers (forget, feedback, assertScopeNamesATarget).
 *    AMENDED 2026-10-18 by owner decision O5 (#1633, epic 1797): "Project
 *    scopes — Exact match. B7 updates the Lean model, the decision record and
 *    the formal tests in the same PR." `project:*` is local-only exactly when
 *    the one resolver (`resolveScopeTarget`) keeps a write to it local, so a
 *    url store that only CONTAINS a project scope no longer makes it remote.
 *    The containment expectations below are changed to the exact-match answer
 *    (plan B Task 7, Step 3).
 *
 * Fake remote via mocked fetch; nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, isLocalOnlyScope, assertScopeNamesATarget } from '../src/index.js'

const URL_STORE = { url: 'https://plur.example.com/sse', scope: 'project:plur' }

describe('Decision E5 — the local family case-folds', () => {
  it.each(['GLOBAL', 'Local', 'PRIMARY', 'Project:plur'])('%s is local-only', s => {
    expect(isLocalOnlyScope(s)).toBe(true)
  })
  it('a folded local scope is a valid target', () => {
    expect(() => assertScopeNamesATarget('Project:plur', [], 'retire from', 'x')).not.toThrow()
  })
  it('personal and shared scopes are still not local-only', () => {
    for (const s of ['user:alice', 'GROUP:acme', 'globalx', 'project']) expect(isLocalOnlyScope(s), s).toBe(false)
  })
})

describe('Decision E4 (amended, O5) — project:* is local-only unless a url store claims it exactly', () => {
  it('exact url store → not local-only', () => {
    expect(isLocalOnlyScope('project:plur', [URL_STORE])).toBe(false)
  })
  it('segment-contained by a url store → local-only (amended E4: exact match, as write routing)', () => {
    expect(isLocalOnlyScope('project:plur/sub', [URL_STORE])).toBe(true)
    expect(isLocalOnlyScope('project:plur:sub', [URL_STORE])).toBe(true)
    expect(isLocalOnlyScope('Project:plur/sub', [URL_STORE])).toBe(true)
  })
  it('a string-prefix sibling is NOT contained (segment-aware)', () => {
    expect(isLocalOnlyScope('project:plurx', [URL_STORE])).toBe(true)
  })
  it('a path (local file) store keeps the scope local', () => {
    const pathStore = { path: '/tmp/x.yaml', scope: 'project:plur' }
    expect(isLocalOnlyScope('project:plur', [pathStore])).toBe(true)
  })
  it('the named local targets never depend on stores', () => {
    expect(isLocalOnlyScope('global', [{ url: 'https://x', scope: 'global' }])).toBe(true)
  })
  it('a descendant still names a target (config-free: a project scope is always a local target)', () => {
    expect(() => assertScopeNamesATarget('project:plur/sub', [URL_STORE], 'retire from', 'x')).not.toThrow()
  })
})

describe('Decision E4 (amended, O5) — forget reaches the url store that claims a project scope exactly', () => {
  let dir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-apply-scopefam-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ ...URL_STORE, token: 'tok', shared: true, readonly: false }],
      index: false,
    }))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (typeof url === 'string' && url.includes('/engrams/ENG-REMOTE-ONLY')) {
        return {
          ok: true, status: 200,
          json: async () => (method === 'DELETE'
            ? { id: 'ENG-REMOTE-ONLY', status: 'retired' }
            : { id: 'ENG-REMOTE-ONLY', scope: 'project:plur/sub', status: 'active', data: { statement: 'remote fact' } }),
          text: async () => '',
        } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    })
    globalThis.fetch = fetchMock as any
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })
  const calls = (m: string) => fetchMock.mock.calls.filter(([, init]) => (init as any)?.method === m)

  it('forget(scope: project:plur) reaches the url store that claims it exactly', async () => {
    const plur = new Plur({ path: dir })
    await plur.forget('ENG-REMOTE-ONLY', 'exact scope', { scope: 'project:plur', force: true })
    expect(calls('DELETE')).toHaveLength(1)
  })

  it('forget(scope: project:plur/sub) stays local: a containing url store does not claim it (amended E4)', async () => {
    const plur = new Plur({ path: dir })
    await expect(plur.forget('ENG-REMOTE-ONLY', 'contained descendant', { scope: 'project:plur/sub', force: true }))
      .rejects.toThrow(/not found in the local store/)
    expect(calls('DELETE')).toHaveLength(0)
  })

  it('an uncovered project scope still never reaches the network', async () => {
    const plur = new Plur({ path: dir })
    await expect(plur.forget('ENG-REMOTE-ONLY', 'x', { scope: 'project:other', force: true }))
      .rejects.toThrow(/not found in the local store/)
    expect(calls('DELETE')).toHaveLength(0)
  })
})
