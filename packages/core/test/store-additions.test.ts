/**
 * 0.24 review round 6: storeAdditions is the one definition of what a
 * rewrite of config.yaml's stores list adds — a new source (server address
 * or local store file) or a new scope on an existing source.
 */
import { describe, it, expect } from 'vitest'
import { storeAdditions } from '../src/store-additions.js'

const A = 'https://a.example.test'
const EVIL = 'https://evil.example.test'
const ME = 'user:x:alice'
const server = (url: string, scopes: string[], extra: Record<string, unknown> = {}) => ({ url, token: 't', scope: ME, scopes, enterprise: {}, ...extra })

describe('storeAdditions', () => {
  it('a new url serving the same personal scope is a new source', () => {
    expect(storeAdditions([server(A, [ME])], [server(A, [ME]), server(EVIL, [ME])])).toEqual({ newSources: [`url:${EVIL}`], newScopes: [] })
  })
  it('a new url serving exactly the scopes another url serves is a new source', () => {
    const before = [server(A, [ME, 'group:x/team'])]
    expect(storeAdditions(before, [...before, server(EVIL, [ME, 'group:x/team'])]).newSources).toEqual([`url:${EVIL}`])
  })
  it('a new scope on an existing url is a new scope', () => {
    expect(storeAdditions([server(A, [ME])], [server(A, [ME, 'group:x/team'])])).toEqual({ newSources: [], newScopes: [`group:x/team@url:${A}`] })
  })
  it('a per-scope url entry for a new scope on a known url is a new scope', () => {
    const before = [{ url: A, token: 't', scope: 'group:x/one' }]
    expect(storeAdditions(before, [...before, { url: `${A}/sse`, token: 't', scope: 'group:x/two' }]).newScopes).toEqual([`group:x/two@url:${A}`])
  })
  it('a new local path is a new source', () => {
    expect(storeAdditions([], [{ path: '/tmp/r6-store/engrams.yaml', scope: 'global' }]).newSources).toHaveLength(1)
  })
  it('a token rotation adds nothing', () => {
    expect(storeAdditions([server(A, [ME])], [server(A, [ME], { token: 't2' })])).toEqual({ newSources: [], newScopes: [] })
    expect(storeAdditions([server(A, [ME])], [server(A, [ME], { token: undefined, token_env: 'PLUR_KEY' })])).toEqual({ newSources: [], newScopes: [] })
  })
  it('a removal adds nothing', () => {
    expect(storeAdditions([server(A, [ME]), { path: '/tmp/x.yaml', scope: 'global' }], [server(A, [ME])])).toEqual({ newSources: [], newScopes: [] })
  })
  it('a reorder adds nothing', () => {
    const a = server(A, [ME]); const b = { path: '/tmp/x.yaml', scope: 'global' }
    expect(storeAdditions([a, b], [b, a])).toEqual({ newSources: [], newScopes: [] })
  })
  it('folding per-scope entries of a url into its server entry adds nothing', () => {
    const before = [server(A, [ME]), { url: A, token: 't', scope: 'group:x/team' }]
    expect(storeAdditions(before, [server(A, [ME, 'group:x/team'])])).toEqual({ newSources: [], newScopes: [] })
  })
  it('a metadata-only change adds nothing', () => {
    const before = [server(A, [ME])]
    const after = [server(A, [ME], { scope_settings: { [ME]: { covers: ['x'], description: 'd' } }, discovery: { status: 'ok' }, readonly: true })]
    expect(storeAdditions(before, after)).toEqual({ newSources: [], newScopes: [] })
  })
})
