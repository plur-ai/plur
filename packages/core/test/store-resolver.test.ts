import { describe, it, expect } from 'vitest'
import { resolveScopeTarget, ScopeConflictError } from '../src/store-resolver.js'
import type { StoreEntry } from '../src/schemas/config.js'

/**
 * One resolver answers "where does a write to this scope go" for write
 * routing and the leak guard alike (#1631; #1239, #1381, #1473). Pure: config
 * in, answer out — no driver, no network.
 */
const A = { url: 'https://plur.example.com', token: 'a', scope: 'project:acme/team/backend', shared: true, readonly: false } as StoreEntry
const E = (extra: Record<string, unknown>) => ({ ...A, ...extra }) as unknown as StoreEntry

describe('resolveScopeTarget (#1631)', () => {
  it('exact url store → remote, writable', () => {
    expect(resolveScopeTarget(A.scope, [A])).toEqual({ kind: 'remote', entry: A, writable: true })
  })

  it('same scope on two servers → conflict naming both', () => {
    const B = E({ url: 'https://other.example.com' })
    expect(resolveScopeTarget(A.scope, [A, B])).toEqual({
      kind: 'conflict', servers: ['https://plur.example.com', 'https://other.example.com'],
    })
  })

  it('same scope twice on one server (two spellings) → remote, not conflict', () => {
    expect(resolveScopeTarget(A.scope, [A, E({ url: 'https://plur.example.com/sse' })]).kind).toBe('remote')
  })

  it('readonly only → remote, writable false', () => {
    expect(resolveScopeTarget(A.scope, [E({ readonly: true })])).toMatchObject({ kind: 'remote', writable: false })
  })

  it('a readonly and a writable entry on one server → remote, writable, through the writable entry', () => {
    const ro = E({ readonly: true, token: 'ro' })
    const t = resolveScopeTarget(A.scope, [ro, A])
    expect(t).toEqual({ kind: 'remote', entry: A, writable: true })
  })

  it('ungranted scope under an enterprise server org → unauthorized', () => {
    const S = E({ scope: 'group:acme/team', enterprise: {}, discovery: { status: 'ok', org_id: 'acme' } })
    expect(resolveScopeTarget('project:acme/other', [S])).toEqual({ kind: 'unauthorized', server: 'https://plur.example.com' })
  })

  it('a server without an enterprise block never makes a scope unauthorized', () => {
    const S = E({ scope: 'group:acme/team', discovery: { status: 'ok', org_id: 'acme' } })
    expect(resolveScopeTarget('project:acme/other', [S])).toEqual({ kind: 'local' })
  })

  it('a scope of another org is not unauthorized on this server', () => {
    const S = E({ scope: 'group:acme/team', enterprise: {}, discovery: { status: 'ok', org_id: 'acme' } })
    expect(resolveScopeTarget('project:globex/x', [S])).toEqual({ kind: 'local' })
  })

  it('the org match is case-folded', () => {
    const S = E({ scope: 'group:acme/team', enterprise: {}, discovery: { status: 'ok', org_id: 'Acme' } })
    expect(resolveScopeTarget('project:ACME/other', [S]).kind).toBe('unauthorized')
  })

  it('the server named in conflict and unauthorized carries no userinfo', () => {
    const B = E({ url: 'https://bob:secret@other.example.com/sse' })
    const t = resolveScopeTarget(A.scope, [A, B])
    expect(t).toEqual({ kind: 'conflict', servers: ['https://plur.example.com', 'https://other.example.com'] })
    expect(JSON.stringify(t)).not.toContain('secret')
  })

  it('a personal scope with a local and a url entry → local (#1515 unchanged)', () => {
    const local = { path: '/tmp/alice.yaml', scope: 'user:acme:alice', shared: false, readonly: false } as StoreEntry
    const url = { url: 'https://plur.example.com', token: 'a', scope: 'user:acme:alice', shared: false, readonly: false } as StoreEntry
    expect(resolveScopeTarget('user:acme:alice', [url, local])).toEqual({ kind: 'local', entry: local })
  })

  it('a personal scope with url entries on two servers → the selected one, not conflict (#1515 unchanged)', () => {
    const ro = { url: 'https://other.example.com', token: 'b', scope: 'user:acme:alice', shared: false, readonly: true } as StoreEntry
    const url = { url: 'https://plur.example.com', token: 'a', scope: 'user:acme:alice', shared: false, readonly: false } as StoreEntry
    expect(resolveScopeTarget('user:acme:alice', [ro, url])).toEqual({ kind: 'remote', entry: url, writable: true })
  })

  it('a path store with the exact scope → local with it', () => {
    const p = { path: '/tmp/team.yaml', scope: 'group:acme/team', shared: true, readonly: false } as StoreEntry
    expect(resolveScopeTarget('group:acme/team', [p])).toEqual({ kind: 'local', entry: p })
  })

  it('an exact url entry wins over a path entry with the same scope', () => {
    const p = { path: '/tmp/team.yaml', scope: A.scope, shared: true, readonly: false } as StoreEntry
    expect(resolveScopeTarget(A.scope, [p, A]).kind).toBe('remote')
  })

  it('matching is exact: a url store whose scope only contains the scope does not route it', () => {
    expect(resolveScopeTarget('project:acme/team/backend/sub', [A])).toEqual({ kind: 'local' })
  })

  it('nothing configured → local', () => {
    expect(resolveScopeTarget('group:acme/team', [])).toEqual({ kind: 'local' })
  })
})

describe('ScopeConflictError', () => {
  it('names the scope and both servers, and says nothing was saved', () => {
    const err = new ScopeConflictError('group:acme/team', ['https://plur.example.com', 'https://other.example.com'])
    expect(err).toBeInstanceOf(Error)
    expect(err.scope).toBe('group:acme/team')
    expect(err.servers).toEqual(['https://plur.example.com', 'https://other.example.com'])
    expect(err.message).toBe(
      'Scope "group:acme/team" is claimed by two servers (https://plur.example.com, https://other.example.com); ' +
      'nothing was saved. Remove it from one of them in config.yaml.',
    )
  })
})
