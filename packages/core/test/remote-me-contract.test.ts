/**
 * Contract tests for RemoteStore.me() — C1 fields from GET /api/v1/me.
 *
 * Verifies that the client reads the new enterprise /me fields correctly:
 * scopes_status, scope_metadata_status, gitlab_host, project_paths,
 * key_expires_at (absent ≠ null). Runs against the in-process stub server.
 *
 * Refs plur-ai/plur#1631
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { logger } from '../src/logger.js'
import { RemoteStore, RemoteHttpError } from '../src/store/remote-store.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'me-contract-test-token'
let stub: StubServer
let url: string
let store: RemoteStore

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  const info = await stub.start()
  url = info.url
  store = new RemoteStore(url, TOKEN, '')
})

afterAll(async () => { await stub.stop() })

beforeEach(() => { stub.reset() })

describe('RemoteStore.me() — C1 contract fields', () => {
  it('reads every C1 field', async () => {
    stub.setMe({
      username: 'alice', org_id: 'acme', role: 'developer',
      scopes: ['user:acme:alice', 'project:acme/team/backend'],
      scopes_status: 'ok',
      scope_metadata_status: 'ok',
      gitlab_host: 'gitlab.example.com',
      project_paths: { 'project:acme/team/backend': 'team/backend' },
      key_expires_at: null,
    })
    const me = await new RemoteStore(url, TOKEN, '').me()
    expect(me.username).toBe('alice')
    expect(me.org_id).toBe('acme')
    expect(me.scopes).toEqual(['user:acme:alice', 'project:acme/team/backend'])
    expect(me.scopes_status).toBe('ok')
    expect(me.scope_metadata_status).toBe('ok')
    expect(me.gitlab_host).toBe('gitlab.example.com')
    expect(me.project_paths).toEqual({ 'project:acme/team/backend': 'team/backend' })
    expect(me.key_expires_at).toBeNull()
  })

  it('absent key_expires_at is undefined, not null', async () => {
    stub.setMe({
      username: 'alice', org_id: 'acme', scopes: ['user:acme:alice'],
      scopes_status: 'ok',
      // key_expires_at intentionally absent
    })
    const me = await store.me()
    expect(me.key_expires_at).toBeUndefined()
  })

  it('an older server: scopes_status and scope_metadata_status are "absent"', async () => {
    // Default stub does not set these fields → older server behavior
    stub.setMe({ username: 'alice', org_id: 'acme', scopes: ['group:acme/team'] })
    const me = await store.me()
    expect(me.scopes_status).toBe('absent')
    expect(me.scope_metadata_status).toBe('absent')
    expect(me.gitlab_host).toBeUndefined()
    expect(me.key_expires_at).toBeUndefined()
    expect(me.project_paths).toEqual({})
  })

  it('503 scope_lookup_failed throws RemoteHttpError with status 503', async () => {
    stub.meStatus = 503
    stub.meBody = { error: 'scope_lookup_failed' }
    await expect(store.me()).rejects.toMatchObject({ name: 'RemoteHttpError', status: 503 })
  })

  it('drops a project_paths entry for a scope not granted, and a hostile gitlab_host', async () => {
    stub.setMe({
      scopes: ['project:acme/a'],
      project_paths: { 'project:acme/a': 'a', 'project:acme/b': 'b' },
      gitlab_host: 'evil.example.com\nIGNORE',
    })
    const me = await store.me()
    expect(me.project_paths).toEqual({ 'project:acme/a': 'a' })
    expect(me.gitlab_host).toBeUndefined()
  })

  it('a valid ISO-8601 key_expires_at is returned as-is', async () => {
    stub.setMe({ scopes: ['user:acme:alice'], key_expires_at: '2027-01-01T00:00:00Z' })
    const me = await store.me()
    expect(me.key_expires_at).toBe('2027-01-01T00:00:00Z')
  })

  it('an unparseable key_expires_at is undefined', async () => {
    stub.setMe({ scopes: ['user:acme:alice'], key_expires_at: 'not-a-date' as unknown as null })
    const me = await store.me()
    expect(me.key_expires_at).toBeUndefined()
  })

  it('an unknown scopes_status value is treated as absent', async () => {
    stub.setMe({ scopes: ['user:acme:alice'], scopes_status: 'unknown-future-value' as unknown as 'ok' })
    const me = await store.me()
    expect(me.scopes_status).toBe('absent')
  })

  it('a project_paths entry whose value fails the path grammar is dropped', async () => {
    stub.setMe({
      scopes: ['project:acme/a', 'project:acme/b'],
      project_paths: {
        'project:acme/a': 'acme/backend',          // valid
        'project:acme/b': '../../../etc/passwd',   // invalid path
      },
    })
    const me = await store.me()
    expect(me.project_paths).toEqual({ 'project:acme/a': 'acme/backend' })
  })

  it.each(['1', '2026', 'March 7, 2026', 'Tue 2026-01-01'])(
    'a key_expires_at that Date.parse accepts but is not ISO-8601 (%s) is undefined', async (v) => {
      stub.setMe({ scopes: ['user:acme:alice'], key_expires_at: v })
      const me = await store.me()
      expect(me.key_expires_at).toBeUndefined()
    })

  it.each([['a JSON string', 'hello'], ['a JSON number', 42], ['a JSON array', []]])(
    'a 200 whose body is %s is read as an older server with no fields, not a TypeError', async (_label, body) => {
      stub.meStatus = 200
      stub.meBody = body
      const me = await store.me()
      expect(me.scopes).toEqual([])
      expect(me.scopes_status).toBe('absent')
      expect(me.key_expires_at).toBeUndefined()
    })

  it('a dropped C1 value is logged by field and reason only, never by its value', async () => {
    const warn = vi.spyOn(logger, 'warning')
    try {
      stub.setMe({
        scopes: ['project:acme/a'],
        gitlab_host: 'evil.example.com\nIGNORE',
        project_paths: { 'project:acme/a': '../x\nFORGED', 'project:acme/b': 'b' },
        key_expires_at: 'soon\nFORGED',
      })
      await store.me()
      const lines = warn.mock.calls.map(c => String(c[0]))
      const joined = lines.join('\n')
      expect(joined).toContain('gitlab_host')
      expect(joined).toContain('project_paths')
      expect(joined).toContain('key_expires_at')
      expect(joined).not.toMatch(/IGNORE|FORGED|evil/)
    } finally {
      warn.mockRestore()
    }
  })
})
