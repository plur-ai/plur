/**
 * #1633 (plan B Task 7, owner decision O5 "exact match"): a `project:` scope
 * is local-only exactly when write routing keeps it local. The one resolver
 * (`resolveScopeTarget`, store-resolver.ts) answers both questions, so the
 * folder check, forget/feedback's network guard and write routing agree.
 *
 * Formal decision E4 is amended from containment to exact match: a url store
 * whose scope only CONTAINS a project scope no longer makes it remote, because
 * write routing never sends that scope there (spec/formal RoutingDiscovery §5).
 *
 * Row 34 (owner decisions, epic 1797): the explicit-scope id lookups
 * (feedback, setPinned, pinnedQuota, forget, the own-namespace check, the
 * learn path's outbox target) read the same resolver, so a scope two servers
 * claim is refused instead of acting on whichever server is listed first.
 *
 * The remote side is a fetch mock that records every request; nothing real is
 * called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, isLocalOnlyScope } from '../src/index.js'
import { setFolderEntry } from '../src/folders.js'
import type { StoreEntry } from '../src/schemas/config.js'

const SERVER = 'https://plur.example.com'
const OTHER = 'https://other.example.com'
const E = {
  url: SERVER, token: 't', scope: 'project:acme/team/backend', shared: true, readonly: false,
  enterprise: {}, discovery: { status: 'ok', org_id: 'acme' },
} as unknown as StoreEntry

describe('isLocalOnlyScope: project scopes by exact match (#1633, O5)', () => {
  it('a discovered project scope is not local-only', () => {
    expect(isLocalOnlyScope('project:acme/team/backend', [E])).toBe(false)
  })
  it('an ungranted project scope under the server org is not local-only', () => {
    expect(isLocalOnlyScope('project:acme/other', [E])).toBe(false)
  })
  it('a project scope no server knows stays local-only', () => {
    expect(isLocalOnlyScope('project:mine', [E])).toBe(true)
  })
  it('containment alone no longer makes a scope remote: agrees with exact-match write routing', () => {
    expect(isLocalOnlyScope('project:acme/team/backend/sub', [{ ...E, enterprise: undefined, discovery: undefined } as unknown as StoreEntry])).toBe(true)
  })
  it('a project scope two servers claim is not local-only (the write path refuses it)', () => {
    expect(isLocalOnlyScope(E.scope, [E, { ...E, url: OTHER } as StoreEntry])).toBe(false)
  })
  it('no stores given: every project scope stays local-only (config-free family unchanged)', () => {
    expect(isLocalOnlyScope('project:acme/team/backend')).toBe(true)
  })
})

describe('folder scopes: plur folders set --scope (#1633)', () => {
  let base: string
  let home: string
  let root: string
  let dir: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'plur-project-scope-folders-'))
    home = join(base, 'home')
    root = join(home, '.plur')
    dir = join(home, 'work', 'backend')
    mkdirSync(root, { recursive: true })
    mkdirSync(dir, { recursive: true })
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('plur folders set --scope with an ungranted project scope is refused naming the server', () => {
    expect(() => setFolderEntry(root, dir, { scope: 'project:acme/other' }, { configuredScopes: [E.scope], stores: [E], home }))
      .toThrow(/not granted to you on https:\/\/plur\.example\.com/)
  })
  it('plur folders set --scope with a discovered project scope is accepted', () => {
    expect(setFolderEntry(root, dir, { scope: E.scope }, { configuredScopes: [E.scope], stores: [E], home }).scope).toBe(E.scope)
  })
  it('a project scope no server knows is accepted without a store, as before', () => {
    expect(setFolderEntry(root, dir, { scope: 'project:mine' }, { configuredScopes: [E.scope], stores: [E], home }).scope).toBe('project:mine')
  })
  it('Plur.setFolder threads the configured stores: an ungranted project scope is refused through the public method', () => {
    writeConfig(root, [{ url: SERVER, token: 't', scopes: [E.scope], enterprise: {}, discovery: { status: 'ok', org_id: 'acme' } }])
    const plur = new Plur({ path: root })
    expect(() => plur.setFolder(dir, { scope: 'project:acme/other' }, { home }))
      .toThrow(/not granted to you on https:\/\/plur\.example\.com/)
    expect(plur.setFolder(dir, { scope: E.scope }, { home }).scope).toBe(E.scope)
  })
})

function writeConfig(dir: string, stores: Array<Record<string, unknown>>) {
  const p = join(dir, 'config.yaml')
  writeFileSync(p, yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }))
  const t = new Date(Date.now() + 5_000)
  utimesSync(p, t, t)
}

describe('explicit-scope lookups go through the resolver (#1633, row 34)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let calls: Array<{ host: string; method: string; path: string }>
  let rowScope: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-project-scope-'))
    originalFetch = globalThis.fetch
    calls = []
    rowScope = E.scope
    globalThis.fetch = vi.fn(async (input: any, init?: { method?: string }) => {
      const url = new URL(typeof input === 'string' ? input : input.url)
      const method = init?.method ?? 'GET'
      calls.push({ host: url.host, method, path: url.pathname })
      if (/\/engrams\/ENG-REMOTE-1$/.test(url.pathname)) {
        return {
          ok: true, status: 200,
          json: async () => (method === 'DELETE'
            ? { id: 'ENG-REMOTE-1', status: 'retired' }
            : { id: 'ENG-REMOTE-1', scope: rowScope, status: 'active', pinned: false, data: { statement: 'remote fact' } }),
          text: async () => '',
        } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], results: [], total_count: 0 }), text: async () => '' } as Response
    }) as any
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })
  const mutating = () => calls.filter(c => c.method !== 'GET')

  it('forget(id, reason, { scope: discovered project scope }) may reach the server', async () => {
    writeConfig(dir, [{ url: SERVER, token: 't', scopes: [E.scope], enterprise: {}, discovery: { status: 'ok', org_id: 'acme' } }])
    const plur = new Plur({ path: dir })
    await plur.forget('ENG-REMOTE-1', 'served project scope', { scope: E.scope, force: true })
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(1)
  })

  it('forget with a project scope a url store only contains stays local (amended E4)', async () => {
    writeConfig(dir, [{ url: SERVER, token: 't', scope: 'project:acme/team', shared: true, readonly: false }])
    const plur = new Plur({ path: dir })
    await expect(plur.forget('ENG-REMOTE-1', 'x', { scope: 'project:acme/team/backend', force: true }))
      .rejects.toThrow(/not found in the local store/)
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
  })

  describe('an explicit scope never reaches a store that does not claim it (gate of #1667)', () => {
    // ENG-REMOTE-1 lives on the server in E.scope (the mock answers it for every GET).
    it('forget with a project scope the company server withholds is refused, nothing deleted', async () => {
      writeConfig(dir, [{ url: SERVER, token: 't', scopes: [E.scope], enterprise: {}, discovery: { status: 'ok', org_id: 'acme' } }])
      const plur = new Plur({ path: dir })
      await expect(plur.forget('ENG-REMOTE-1', 'x', { scope: 'project:acme/other', force: true }))
        .rejects.toThrow(/not granted to you on https:\/\/plur\.example\.com.*nothing was retired/)
      expect(mutating()).toHaveLength(0)
    })

    it('feedback with a project scope the company server withholds is refused, nothing rated', async () => {
      writeConfig(dir, [{ url: SERVER, token: 't', scopes: [E.scope], enterprise: {}, discovery: { status: 'ok', org_id: 'acme' } }])
      const plur = new Plur({ path: dir })
      await expect(plur.feedback('ENG-REMOTE-1', 'positive', 'project:acme/other'))
        .rejects.toThrow(/not granted to you on https:\/\/plur\.example\.com.*nothing was rated/)
      expect(mutating()).toHaveLength(0)
    })

    it('forget with a personal scope a local store keeps does not retire a row of another url store', async () => {
      writeFileSync(join(dir, 'personal.yaml'), 'engrams: []\n')
      writeConfig(dir, [
        { path: join(dir, 'personal.yaml'), scope: 'user:acme:me' },
        { url: SERVER, token: 't', scope: 'user:acme:me', shared: false, readonly: false },
        { url: SERVER, token: 't', scope: E.scope, shared: true, readonly: false },
      ])
      const plur = new Plur({ path: dir })
      await expect(plur.forget('ENG-REMOTE-1', 'x', { scope: 'user:acme:me', force: true })).rejects.toThrow(/not found/i)
      expect(mutating()).toHaveLength(0)
    })

    it('feedback with a personal scope a local store keeps does not rate a row of another url store', async () => {
      writeFileSync(join(dir, 'personal.yaml'), 'engrams: []\n')
      writeConfig(dir, [
        { path: join(dir, 'personal.yaml'), scope: 'user:acme:me' },
        { url: SERVER, token: 't', scope: 'user:acme:me', shared: false, readonly: false },
        { url: SERVER, token: 't', scope: E.scope, shared: true, readonly: false },
      ])
      const plur = new Plur({ path: dir })
      await expect(plur.feedback('ENG-REMOTE-1', 'positive', 'user:acme:me')).rejects.toThrow(/not found/i)
      expect(mutating()).toHaveLength(0)
    })
  })

  describe('a personal scope a local store keeps never reaches the server (gate of #1667, Codex r1)', () => {
    const personal = (readonlyPath = false) => {
      writeFileSync(join(dir, 'personal.yaml'), 'engrams: []\n')
      writeConfig(dir, [
        { path: join(dir, 'personal.yaml'), scope: 'user:acme:me', ...(readonlyPath ? { readonly: true } : {}) },
        { url: SERVER, token: 't', scope: 'user:acme:me', shared: false, readonly: false },
      ])
      rowScope = 'user:acme:me'
    }

    it('forget does not retire the same-scope row on the url store', async () => {
      personal()
      const plur = new Plur({ path: dir })
      await expect(plur.forget('ENG-REMOTE-1', 'x', { scope: 'user:acme:me', force: true })).rejects.toThrow(/not found/i)
      expect(mutating()).toHaveLength(0)
    })

    it('feedback does not rate the same-scope row on the url store', async () => {
      personal()
      const plur = new Plur({ path: dir })
      await expect(plur.feedback('ENG-REMOTE-1', 'positive', 'user:acme:me')).rejects.toThrow(/not found/i)
      expect(mutating()).toHaveLength(0)
    })

    it('setPinned keeps the selection of a readonly local store: no PATCH to the url store', async () => {
      personal(true)
      const plur = new Plur({ path: dir })
      await expect(plur.setPinned('ENG-REMOTE-1', true, { scope: 'user:acme:me' })).rejects.toThrow(/no writable url store/)
      expect(mutating()).toHaveLength(0)
    })

    it('pinnedQuota offers no candidate setPinned would refuse', async () => {
      personal()
      const plur = new Plur({ path: dir })
      const local = (await plur.learnAsync('a local fact for the pin quota check', { scope: 'primary' } as any)).engram
      await expect(plur.setPinned(local.id, true, { scope: 'user:acme:me' })).rejects.toThrow(/no writable url store/)
      const q = await plur.pinnedQuota(local.id, { scope: 'user:acme:me' })
      expect(q.candidate).toBeUndefined()
    })
  })

  describe('a scope two servers claim', () => {
    beforeEach(() => {
      writeConfig(dir, [
        { url: SERVER, token: 'a', scope: E.scope, shared: true, readonly: false },
        { url: OTHER, token: 'b', scope: E.scope, shared: true, readonly: false },
      ])
    })

    it('forget is refused and no server is asked to delete', async () => {
      const plur = new Plur({ path: dir })
      await expect(plur.forget('ENG-REMOTE-1', 'x', { scope: E.scope, force: true }))
        .rejects.toThrow(/claimed by two servers.*plur\.example\.com.*other\.example\.com/)
      expect(calls).toHaveLength(0)
    })

    it('feedback is refused and no server is rated', async () => {
      const plur = new Plur({ path: dir })
      await expect(plur.feedback('ENG-REMOTE-1', 'positive', E.scope)).rejects.toThrow(/claimed by two servers/)
      expect(calls).toHaveLength(0)
    })

    it('setPinned is refused and no server is patched', async () => {
      const plur = new Plur({ path: dir })
      await expect(plur.setPinned('ENG-REMOTE-1', true, { scope: E.scope })).rejects.toThrow(/claimed by two servers/)
      expect(mutating()).toHaveLength(0)
    })

    it('pinnedQuota does not cost a candidate on whichever server is listed first', async () => {
      const plur = new Plur({ path: dir })
      const q = await plur.pinnedQuota('ENG-REMOTE-1', { scope: E.scope })
      expect(q.candidate).toBeUndefined()
      expect(calls.filter(c => c.path.endsWith('/ENG-REMOTE-1'))).toHaveLength(0)
    })
  })
})
