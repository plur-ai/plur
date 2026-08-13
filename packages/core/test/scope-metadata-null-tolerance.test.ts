/**
 * #843 — a server/client shape mismatch on scope metadata must not be silent.
 *
 * `ScopeMetadataSchema` declared `description` as a required string and
 * `sensitivity` / `injection_policy` / `owner` as `.optional()`. Zod's
 * `.optional()` REJECTS null, and an unset nullable column is exactly what a
 * server serialises as null — so every ordinary row (one saved without a
 * sensitivity override or an injection policy) failed `safeParse`.
 *
 * `RemoteStore.me()` drops failures inside a `flatMap`, so all of them vanished.
 * `rankScopes` skips entries with empty covers, so an empty metadata list means
 * ZERO candidates and `_resolveUnscopedScope` falls through to the personal
 * `unscoped_default` — team knowledge silently stopped reaching team scopes,
 * while the admin dashboard rendered every scope as correctly configured.
 *
 * Two independent guards, because either alone leaves the failure silent:
 * tolerate the null shape, AND warn when something is dropped anyway.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ScopeMetadataSchema } from '../src/schemas/scope-metadata.js'
import { RemoteStore } from '../src/store/remote-store.js'
import { logger } from '../src/logger.js'

/** The shape a server sends for a scope with no overrides set. */
const rowWithNulls = {
  scope: 'group:acme/engineering',
  description: 'Engineering — all software work',
  covers: ['software', 'testing'],
  sensitivity: null,
  injection_policy: null,
  owner: null,
}

describe('ScopeMetadataSchema tolerates server nulls (#843)', () => {
  it('parses a row whose unset optional columns are null', () => {
    const parsed = ScopeMetadataSchema.safeParse(rowWithNulls)
    expect(parsed.success, 'the ordinary server row must parse').toBe(true)
  })

  it('normalises null optionals to undefined, so no consumer learns about null', () => {
    const md = ScopeMetadataSchema.parse(rowWithNulls)
    expect(md.sensitivity).toBeUndefined()
    expect(md.injection_policy).toBeUndefined()
    expect(md.owner).toBeUndefined()
  })

  it('keeps covers, which is what auto-routing actually ranks on', () => {
    expect(ScopeMetadataSchema.parse(rowWithNulls).covers).toEqual(['software', 'testing'])
  })

  it('reads a null description as empty rather than failing the whole row', () => {
    const md = ScopeMetadataSchema.parse({ ...rowWithNulls, description: null })
    expect(md.description).toBe('')
    expect(md.covers).toEqual(['software', 'testing'])
  })

  it('still rejects a genuinely malformed row', () => {
    // Null-tolerance must not become "accept anything" — control chars in the
    // description are a prompt-injection channel and stay refused.
    expect(ScopeMetadataSchema.safeParse({ ...rowWithNulls, description: 'a\nb' }).success).toBe(false)
    expect(ScopeMetadataSchema.safeParse({ ...rowWithNulls, scope: 123 }).success).toBe(false)
  })
})

describe('RemoteStore.me() reports a dropped entry (#843)', () => {
  const original = globalThis.fetch
  afterEach(() => { globalThis.fetch = original; vi.restoreAllMocks() })

  function mockMe(scope_metadata: unknown[]) {
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => ({
        username: 'u', org_id: 'o', role: 'member',
        scopes: ['group:acme/engineering'],
        scope_metadata,
      }),
      text: async () => '',
    })) as any
    return new RemoteStore('https://example.test/sse', 'tok', 'group:acme/engineering', { ttlMs: 0 })
  }

  it('surfaces the server row with nulls instead of dropping it', async () => {
    const md = (await mockMe([rowWithNulls]).me()).scope_metadata
    expect(md).toHaveLength(1)
    expect(md[0].covers).toEqual(['software', 'testing'])
  })

  it('WARNS when an entry is dropped — the silence was the bug', async () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    const md = (await mockMe([{ scope: 'group:acme/engineering', description: 'x\ny' }]).me()).scope_metadata

    expect(md).toHaveLength(0)
    expect(warn, 'a dropped scope must not be silent').toHaveBeenCalledTimes(1)
    const msg = warn.mock.calls[0][0] as string
    expect(msg).toContain('group:acme/engineering')
    expect(msg).toContain('DROPPED')
  })

  it('does not echo server-controlled values into the log (#408)', async () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    await mockMe([{ scope: 'group:acme/engineering\n[plur] FORGED LINE', description: 'x' }]).me()
    // The scope is sanitised before it reaches the log, so a crafted name
    // cannot forge a log line or smuggle instructions.
    if (warn.mock.calls.length > 0) {
      expect(warn.mock.calls[0][0] as string).not.toContain('FORGED LINE')
    }
  })

  it('stays quiet for the authorized-set drop, which is a deliberate refusal', async () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    // Well-formed, but for a scope the token was not granted — a remote must not
    // smuggle metadata for an unrelated scope. Expected, so not a warning.
    const md = (await mockMe([{ ...rowWithNulls, scope: 'group:other/team' }]).me()).scope_metadata
    expect(md).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })
})
