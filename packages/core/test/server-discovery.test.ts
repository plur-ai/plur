/**
 * acceptDiscoveredScopes — the pure decision table for a server's /me answer.
 *
 * A failed, unauthorised, not-yet-synced or degraded answer never replaces a
 * non-empty cached scope list; an empty list is accepted only when the server
 * says `scopes_status: 'ok'`. Accepted scopes are filtered to the server's org.
 *
 * Refs plur-ai/plur#1631
 */
import { describe, it, expect } from 'vitest'
import { acceptDiscoveredScopes } from '../src/server-discovery.js'
import type { MeResponse } from '../src/store/remote-store.js'

const me = (o: Partial<MeResponse>): MeResponse => ({
  username: 'alice', org_id: 'acme', role: 'developer', scopes: [], scope_metadata: [], capabilities: [],
  scopes_status: 'ok', scope_metadata_status: 'ok', gitlab_host: null, project_paths: {}, key_expires_at: undefined, ...o,
})
const none = new Map<string, string>()

describe('acceptDiscoveredScopes — decision table', () => {
  it('503 keeps a non-empty cache', () => {
    expect(acceptDiscoveredScopes({ me: null, error: { status: 503, message: 'x' }, cached: ['group:acme/team'], otherServersScopes: none }))
      .toMatchObject({ status: 'failed', replaceCache: false })
  })

  it('401 and 403 are auth_failed and keep the cache', () => {
    for (const status of [401, 403]) {
      expect(acceptDiscoveredScopes({ me: null, error: { status, message: 'x' }, cached: ['group:acme/team'], otherServersScopes: none }))
        .toMatchObject({ status: 'auth_failed', replaceCache: false })
    }
  })

  it('a timeout or network error (no status) is failed and keeps the cache', () => {
    expect(acceptDiscoveredScopes({ me: null, error: { message: 'timed out' }, cached: ['group:acme/team'], otherServersScopes: none }))
      .toMatchObject({ status: 'failed', replaceCache: false })
  })

  it('a failed answer never replaces even an empty cache', () => {
    expect(acceptDiscoveredScopes({ me: null, error: { status: 500, message: 'x' }, cached: [], otherServersScopes: none }))
      .toMatchObject({ status: 'failed', replaceCache: false })
  })

  it('scopes_status ok with [] replaces the cache with []', () => {
    expect(acceptDiscoveredScopes({ me: me({ scopes: [] }), cached: ['group:acme/team'], otherServersScopes: none }))
      .toEqual({ status: 'ok', replaceCache: true, scopes: [], rejected: [] })
  })

  it('scopes_status ok with a list replaces the cache', () => {
    expect(acceptDiscoveredScopes({ me: me({ scopes: ['user:acme:alice', 'group:acme/team'] }), cached: ['group:acme/old'], otherServersScopes: none }))
      .toEqual({ status: 'ok', replaceCache: true, scopes: ['user:acme:alice', 'group:acme/team'], rejected: [] })
  })

  it('older server empty list keeps cache', () => {
    expect(acceptDiscoveredScopes({ me: me({ scopes: [], scopes_status: 'absent' }), cached: ['group:acme/team'], otherServersScopes: none }))
      .toMatchObject({ status: 'degraded', replaceCache: false })
  })

  it('older server empty list with an empty cache replaces it with []', () => {
    expect(acceptDiscoveredScopes({ me: me({ scopes: [], scopes_status: 'absent' }), cached: [], otherServersScopes: none }))
      .toEqual({ status: 'degraded', replaceCache: true, scopes: [], rejected: [] })
  })

  it('older server with a non-empty list is ok and replaces the cache', () => {
    expect(acceptDiscoveredScopes({ me: me({ scopes: ['group:acme/team'], scopes_status: 'absent' }), cached: [], otherServersScopes: none }))
      .toEqual({ status: 'ok', replaceCache: true, scopes: ['group:acme/team'], rejected: [] })
  })

  it('not_synced keeps a non-empty cache', () => {
    expect(acceptDiscoveredScopes({ me: me({ scopes: ['group:acme/new'], scopes_status: 'not_synced' }), cached: ['group:acme/team'], otherServersScopes: none }))
      .toMatchObject({ status: 'not_synced', replaceCache: false })
  })

  it('not_synced with an empty cache replaces it with []', () => {
    expect(acceptDiscoveredScopes({ me: me({ scopes: ['group:acme/new'], scopes_status: 'not_synced' }), cached: [], otherServersScopes: none }))
      .toEqual({ status: 'not_synced', replaceCache: true, scopes: [], rejected: [] })
  })

  it('when the cache is kept, scopes is the cached list unchanged', () => {
    const cached = ['group:acme/team', 'user:acme:alice']
    const r = acceptDiscoveredScopes({ me: null, error: { status: 503, message: 'x' }, cached, otherServersScopes: none })
    expect(r).toEqual({ status: 'failed', replaceCache: false, scopes: cached, rejected: [] })
    expect(r.scopes).not.toBe(cached)
  })
})

describe('acceptDiscoveredScopes — org filter', () => {
  it('org prefix: rejects another org, another user, global', () => {
    const r = acceptDiscoveredScopes({ me: me({ scopes: ['group:acme/team', 'group:acmex/team', 'user:acme:bob', 'user:acme:alice', 'global'] }), cached: [], otherServersScopes: none })
    expect(r.scopes).toEqual(['group:acme/team', 'user:acme:alice'])
    expect(r.rejected).toEqual([
      { scope: 'group:acmex/team', reason: 'org-prefix' }, { scope: 'user:acme:bob', reason: 'foreign-personal' }, { scope: 'global', reason: 'org-prefix' }])
  })

  it('group/project/team/space accept <kind>:<org> and <kind>:<org>/…; org: only org:<org>', () => {
    const scopes = ['group:acme', 'project:acme/team/backend', 'team:acme/web', 'space:acme', 'org:acme', 'org:acme/x', 'org:other', 'project:acmeteam/x']
    const r = acceptDiscoveredScopes({ me: me({ scopes }), cached: [], otherServersScopes: none })
    expect(r.scopes).toEqual(['group:acme', 'project:acme/team/backend', 'team:acme/web', 'space:acme', 'org:acme'])
    expect(r.rejected).toEqual([
      { scope: 'org:acme/x', reason: 'org-prefix' }, { scope: 'org:other', reason: 'org-prefix' }, { scope: 'project:acmeteam/x', reason: 'org-prefix' }])
  })

  it('the personal scope compares case-folded and keeps its original spelling', () => {
    const r = acceptDiscoveredScopes({ me: me({ username: 'Alice', org_id: 'Acme', scopes: ['user:acme:ALICE'] }), cached: [], otherServersScopes: none })
    expect(r.scopes).toEqual(['user:acme:ALICE'])
    expect(r.rejected).toEqual([])
  })

  it('a user: scope of another org is foreign-personal', () => {
    const r = acceptDiscoveredScopes({ me: me({ scopes: ['user:other:alice', 'user:alice'] }), cached: [], otherServersScopes: none })
    expect(r.rejected).toEqual([{ scope: 'user:other:alice', reason: 'foreign-personal' }, { scope: 'user:alice', reason: 'foreign-personal' }])
  })

  it('an empty org_id rejects everything as org-prefix and is degraded: a non-empty cache stays', () => {
    const r = acceptDiscoveredScopes({ me: me({ org_id: '', scopes: ['group:/team', 'user::alice', 'group:acme/team'] }), cached: ['group:acme/team'], otherServersScopes: none })
    expect(r).toEqual({
      status: 'degraded', replaceCache: false, scopes: ['group:acme/team'],
      rejected: [{ scope: 'group:/team', reason: 'org-prefix' }, { scope: 'user::alice', reason: 'org-prefix' }, { scope: 'group:acme/team', reason: 'org-prefix' }],
    })
  })

  it('an empty org_id from an older server (no scopes_status) is degraded too', () => {
    expect(acceptDiscoveredScopes({ me: me({ org_id: '', scopes_status: 'absent', scopes: ['group:acme/team'] }), cached: ['group:acme/team'], otherServersScopes: none }))
      .toMatchObject({ status: 'degraded', replaceCache: false, scopes: ['group:acme/team'] })
  })

  it('an empty org_id with an empty cache replaces it with [] (degraded)', () => {
    expect(acceptDiscoveredScopes({ me: me({ org_id: '', scopes: ['group:acme/team'] }), cached: [], otherServersScopes: none }))
      .toMatchObject({ status: 'degraded', replaceCache: true, scopes: [] })
  })

  it('a scope another server already serves is refused', () => {
    const other = new Map([['group:acme/team', 'https://other.example.com']])
    const r = acceptDiscoveredScopes({ me: me({ scopes: ['group:acme/team', 'user:acme:alice'] }), cached: [], otherServersScopes: other })
    expect(r.scopes).toEqual(['user:acme:alice'])
    expect(r.rejected).toEqual([{ scope: 'group:acme/team', reason: 'claimed-by-other-server' }])
  })
})
