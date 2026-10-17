/**
 * Pure unit tests for acceptDiscoveredScopes — the decision table that decides
 * whether a /me answer replaces the cached scope list or is discarded.
 *
 * No HTTP, no filesystem, no timers — just the pure function.
 * Refs plur-ai/plur#1631
 */
import { describe, it, expect } from 'vitest'
import {
  acceptDiscoveredScopes,
  type AcceptedDiscovery,
} from '../src/server-discovery.js'
import type { MeResponse } from '../src/store/remote-store.js'

const me = (o: Partial<MeResponse>): MeResponse => ({
  username: 'alice',
  org_id: 'acme',
  role: 'developer',
  scopes: [],
  scope_metadata: [],
  capabilities: [],
  scopes_status: 'ok',
  scope_metadata_status: 'ok',
  gitlab_host: null,
  project_paths: {},
  key_expires_at: undefined,
  ...o,
})

const none = new Map<string, string>()

describe('acceptDiscoveredScopes — error cases', () => {
  it('503 keeps a non-empty cache (status: failed, replaceCache: false)', () => {
    expect(
      acceptDiscoveredScopes({
        me: null,
        error: { status: 503, message: 'scope_lookup_failed' },
        cached: ['group:acme/team'],
        otherServersScopes: none,
      }),
    ).toMatchObject({ status: 'failed', replaceCache: false })
  })

  it('network error keeps a non-empty cache (status: failed, replaceCache: false)', () => {
    expect(
      acceptDiscoveredScopes({
        me: null,
        error: { message: 'ECONNREFUSED' },
        cached: ['group:acme/team'],
        otherServersScopes: none,
      }),
    ).toMatchObject({ status: 'failed', replaceCache: false })
  })

  it('401 → auth_failed, replaceCache: false', () => {
    expect(
      acceptDiscoveredScopes({
        me: null,
        error: { status: 401, message: 'Unauthorized' },
        cached: ['group:acme/team'],
        otherServersScopes: none,
      }),
    ).toMatchObject({ status: 'auth_failed', replaceCache: false })
  })

  it('403 → auth_failed, replaceCache: false', () => {
    expect(
      acceptDiscoveredScopes({
        me: null,
        error: { status: 403, message: 'Forbidden' },
        cached: ['group:acme/team'],
        otherServersScopes: none,
      }),
    ).toMatchObject({ status: 'auth_failed', replaceCache: false })
  })

  it('auth_failed on empty cache still replaceCache: false', () => {
    expect(
      acceptDiscoveredScopes({
        me: null,
        error: { status: 401, message: 'Unauthorized' },
        cached: [],
        otherServersScopes: none,
      }),
    ).toMatchObject({ status: 'auth_failed', replaceCache: false })
  })
})

describe('acceptDiscoveredScopes — scopes_status: ok', () => {
  it('scopes_status ok with [] replaces the cache with []', () => {
    expect(
      acceptDiscoveredScopes({
        me: me({ scopes: [] }),
        cached: ['group:acme/team'],
        otherServersScopes: none,
      }),
    ).toEqual({ status: 'ok', replaceCache: true, scopes: [], rejected: [] })
  })

  it('scopes_status ok with scopes replaces the cache', () => {
    const r = acceptDiscoveredScopes({
      me: me({ scopes: ['user:acme:alice', 'group:acme/team'] }),
      cached: [],
      otherServersScopes: none,
    })
    expect(r.status).toBe('ok')
    expect(r.replaceCache).toBe(true)
    expect(r.scopes).toEqual(['user:acme:alice', 'group:acme/team'])
    expect(r.rejected).toEqual([])
  })
})

describe('acceptDiscoveredScopes — scopes_status: not_synced', () => {
  it('not_synced keeps a non-empty cache (replaceCache: false)', () => {
    expect(
      acceptDiscoveredScopes({
        me: me({ scopes: [], scopes_status: 'not_synced' }),
        cached: ['group:acme/team'],
        otherServersScopes: none,
      }),
    ).toMatchObject({ status: 'not_synced', replaceCache: false })
  })

  it('not_synced on empty cache replaces with [] (replaceCache: true)', () => {
    expect(
      acceptDiscoveredScopes({
        me: me({ scopes: [], scopes_status: 'not_synced' }),
        cached: [],
        otherServersScopes: none,
      }),
    ).toEqual({ status: 'not_synced', replaceCache: true, scopes: [], rejected: [] })
  })
})

describe('acceptDiscoveredScopes — scopes_status: absent (older server)', () => {
  it('older server empty list keeps cache (status: degraded, replaceCache: false)', () => {
    expect(
      acceptDiscoveredScopes({
        me: me({ scopes: [], scopes_status: 'absent' }),
        cached: ['group:acme/team'],
        otherServersScopes: none,
      }),
    ).toMatchObject({ status: 'degraded', replaceCache: false })
  })

  it('older server non-empty list → ok, replaceCache: true', () => {
    const r = acceptDiscoveredScopes({
      me: me({ scopes: ['user:acme:alice'], scopes_status: 'absent' }),
      cached: [],
      otherServersScopes: none,
    })
    expect(r.status).toBe('ok')
    expect(r.replaceCache).toBe(true)
  })

  it('older server empty list on empty cache → degraded, replaceCache: true (empty replaces empty)', () => {
    expect(
      acceptDiscoveredScopes({
        me: me({ scopes: [], scopes_status: 'absent' }),
        cached: [],
        otherServersScopes: none,
      }),
    ).toMatchObject({ status: 'degraded', replaceCache: true })
  })
})

describe('acceptDiscoveredScopes — scope filtering', () => {
  it('org prefix: rejects another org, another user, global', () => {
    const r = acceptDiscoveredScopes({
      me: me({
        scopes: [
          'group:acme/team',
          'group:acmex/team',
          'user:acme:bob',
          'user:acme:alice',
          'global',
        ],
      }),
      cached: [],
      otherServersScopes: none,
    })
    expect(r.scopes).toEqual(['group:acme/team', 'user:acme:alice'])
    expect(r.rejected).toEqual([
      { scope: 'group:acmex/team', reason: 'org-prefix' },
      { scope: 'user:acme:bob', reason: 'foreign-personal' },
      { scope: 'global', reason: 'org-prefix' },
    ])
  })

  it('project: and team: and space: scopes must share the org prefix', () => {
    const r = acceptDiscoveredScopes({
      me: me({
        scopes: [
          'project:acme/backend',
          'project:other/backend',
          'team:acme/eng',
          'team:other/eng',
          'space:acme/docs',
          'space:other/docs',
        ],
      }),
      cached: [],
      otherServersScopes: none,
    })
    expect(r.scopes).toEqual(['project:acme/backend', 'team:acme/eng', 'space:acme/docs'])
    expect(r.rejected.map((x) => x.scope)).toEqual([
      'project:other/backend',
      'team:other/eng',
      'space:other/docs',
    ])
    expect(r.rejected.every((x) => x.reason === 'org-prefix')).toBe(true)
  })

  it('org: scope: exact match org:<org_id> passes, anything else is rejected', () => {
    const r = acceptDiscoveredScopes({
      me: me({ scopes: ['org:acme', 'org:other', 'org:acme/sub'] }),
      cached: [],
      otherServersScopes: none,
    })
    expect(r.scopes).toEqual(['org:acme'])
    expect(r.rejected.map((x) => x.scope)).toEqual(['org:other', 'org:acme/sub'])
    expect(r.rejected.every((x) => x.reason === 'org-prefix')).toBe(true)
  })

  it('user: exact match is case-folded, original spelling kept', () => {
    const r = acceptDiscoveredScopes({
      me: me({ username: 'Alice', org_id: 'Acme', scopes: ['user:Acme:Alice'] }),
      cached: [],
      otherServersScopes: none,
    })
    expect(r.scopes).toEqual(['user:Acme:Alice'])
    expect(r.rejected).toEqual([])
  })

  it('user: wrong org is foreign-personal', () => {
    const r = acceptDiscoveredScopes({
      me: me({ scopes: ['user:other:alice'] }),
      cached: [],
      otherServersScopes: none,
    })
    expect(r.rejected).toEqual([{ scope: 'user:other:alice', reason: 'foreign-personal' }])
  })

  it('a scope another server already serves is refused (claimed-by-other-server)', () => {
    const r = acceptDiscoveredScopes({
      me: me({ scopes: ['group:acme/team', 'project:acme/backend'] }),
      cached: [],
      otherServersScopes: new Map([['group:acme/team', 'https://other.example.com']]),
    })
    expect(r.scopes).toEqual(['project:acme/backend'])
    expect(r.rejected).toEqual([
      { scope: 'group:acme/team', reason: 'claimed-by-other-server' },
    ])
  })

  it('empty org_id rejects all scopes with org-prefix', () => {
    const r = acceptDiscoveredScopes({
      me: me({ org_id: '', scopes: ['group:acme/team', 'user:acme:alice'] }),
      cached: [],
      otherServersScopes: none,
    })
    expect(r.scopes).toEqual([])
    expect(r.rejected.every((x) => x.reason === 'org-prefix')).toBe(true)
  })

  it('scope that is exactly <kind>:<org_id> (no sub-path) is accepted', () => {
    const r = acceptDiscoveredScopes({
      me: me({ scopes: ['group:acme'] }),
      cached: [],
      otherServersScopes: none,
    })
    expect(r.scopes).toEqual(['group:acme'])
    expect(r.rejected).toEqual([])
  })

  it('scope filtering returns empty rejected list when all scopes pass', () => {
    const r = acceptDiscoveredScopes({
      me: me({
        scopes: ['user:acme:alice', 'group:acme/team', 'project:acme/backend'],
      }),
      cached: [],
      otherServersScopes: none,
    })
    expect(r.rejected).toEqual([])
    expect(r.scopes).toEqual(['user:acme:alice', 'group:acme/team', 'project:acme/backend'])
  })
})

describe('acceptDiscoveredScopes — replaceCache false returns empty scopes', () => {
  it('when replaceCache is false, scopes is [] and rejected is []', () => {
    const r = acceptDiscoveredScopes({
      me: null,
      error: { status: 503, message: 'x' },
      cached: ['group:acme/team'],
      otherServersScopes: none,
    })
    expect(r.scopes).toEqual([])
    expect(r.rejected).toEqual([])
  })
})
