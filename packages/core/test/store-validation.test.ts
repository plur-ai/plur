import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

/**
 * addStore() validation gate — closes plur-ai/plur#93.
 *
 * Pre-#93, addStore() accepted any URL/token without validation and silently
 * registered duplicates. First use surfaced the error; first use is often
 * minutes/hours after registration. These tests pin the new fail-at-registration
 * semantics.
 */
describe('addStore validation (#93)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-store-val-'))
    plur = new Plur({ path: dir })
  })

  afterEach(() => { rmSync(dir, { recursive: true }) })

  describe('URL validation', () => {
    it('accepts valid https URL', () => {
      expect(() =>
        plur.addStore('', 'group:test', { url: 'https://plur.datafund.io', token: 'tok' })
      ).not.toThrow()
    })

    it('accepts valid http URL (for local dev)', () => {
      expect(() =>
        plur.addStore('', 'group:test', { url: 'http://localhost:3000', token: 'tok' })
      ).not.toThrow()
    })

    it('rejects malformed URL with clear error', () => {
      expect(() =>
        plur.addStore('', 'group:test', { url: 'not a url at all', token: 'tok' })
      ).toThrow(/invalid URL/i)
    })

    it('rejects unsupported protocol (file://) with clear error', () => {
      expect(() =>
        plur.addStore('', 'group:test', { url: 'file:///etc/passwd', token: 'tok' })
      ).toThrow(/unsupported protocol/i)
    })

    it('rejects unsupported protocol (ftp://) with clear error', () => {
      expect(() =>
        plur.addStore('', 'group:test', { url: 'ftp://example.com', token: 'tok' })
      ).toThrow(/unsupported protocol/i)
    })

    it('rejects empty storePath for local store', () => {
      expect(() =>
        plur.addStore('', 'group:test')
      ).toThrow(/storePath must be a non-empty string/i)
    })

    it('rejects empty scope', () => {
      expect(() =>
        plur.addStore('', '', { url: 'https://example.com', token: 'tok' })
      ).toThrow(/scope must be a non-empty string/i)
    })
  })

  describe('duplicate handling', () => {
    it('idempotent on same URL + same scope — second call is a no-op', () => {
      plur.addStore('', 'group:test', { url: 'https://plur.datafund.io', token: 'tok' })
      expect(() =>
        plur.addStore('', 'group:test', { url: 'https://plur.datafund.io', token: 'tok' })
      ).not.toThrow()

      const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
      expect(config.stores).toHaveLength(1)
    })

    it('rejects different URL with same scope (no silent ambiguity)', () => {
      plur.addStore('', 'group:test', { url: 'https://plur.datafund.io', token: 'tok' })
      expect(() =>
        plur.addStore('', 'group:test', { url: 'https://other.example.com', token: 'tok2' })
      ).toThrow(/scope "group:test" is already registered/)
    })

    it('overwrites with overwriteScope: true', () => {
      plur.addStore('', 'group:test', { url: 'https://plur.datafund.io', token: 'tok' })
      expect(() =>
        plur.addStore('', 'group:test', {
          url: 'https://other.example.com',
          token: 'tok2',
          overwriteScope: true,
        })
      ).not.toThrow()

      const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
      expect(config.stores).toHaveLength(1)
      expect(config.stores[0].url).toBe('https://other.example.com')
      expect(config.stores[0].token).toBe('tok2')
    })

    it('rejects different local path with same scope', () => {
      plur.addStore('/tmp/store-a/engrams.yaml', 'space:test')
      expect(() =>
        plur.addStore('/tmp/store-b/engrams.yaml', 'space:test')
      ).toThrow(/scope "space:test" is already registered/)
    })

    it('rejects mixing local + remote on the same scope', () => {
      plur.addStore('/tmp/local-store/engrams.yaml', 'group:test')
      expect(() =>
        plur.addStore('', 'group:test', { url: 'https://example.com', token: 't' })
      ).toThrow(/already registered/)
    })

    it('allows different scopes for different stores', () => {
      plur.addStore('', 'group:a', { url: 'https://a.example.com', token: 'tok' })
      plur.addStore('', 'group:b', { url: 'https://b.example.com', token: 'tok' })

      const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
      expect(config.stores).toHaveLength(2)
    })
  })

  /**
   * Multiple scopes per remote URL — closes plur-ai/plur#291.
   *
   * One enterprise instance hosts many team scopes a user is authorized for.
   * Dedup keyed on URL alone dropped every scope after the first while still
   * returning success. Identity is endpoint + scope, so each authorized scope
   * must register and persist independently.
   */
  describe('multiple scopes per remote URL (#291)', () => {
    const URL = 'https://plur.datafund.io/sse'

    it('persists a second scope on an already-registered URL', () => {
      plur.addStore('', 'group:plur/plur-ai/engineering', { url: URL, token: 'tok' })
      plur.addStore('', 'group:plur/plur-ai/comms', { url: URL, token: 'tok' })

      const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
      expect(config.stores).toHaveLength(2)
      const scopes = config.stores.map((s: any) => s.scope).sort()
      expect(scopes).toEqual(['group:plur/plur-ai/comms', 'group:plur/plur-ai/engineering'])
      // Both entries point at the same URL — the URL is not the identity.
      expect(config.stores.every((s: any) => s.url === URL)).toBe(true)
    })

    it('registers every authorized scope on one enterprise URL (the live repro)', () => {
      const scopes = [
        'group:plur/plur-ai',
        'group:plur/plur-ai/engineering',
        'group:plur/plur-ai/comms',
        'group:plur/plur-ai/research',
        'group:plur/plur-ai/leadership',
      ]
      for (const scope of scopes) plur.addStore('', scope, { url: URL, token: 'tok' })

      const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
      expect(config.stores).toHaveLength(scopes.length)
      expect(config.stores.map((s: any) => s.scope).sort()).toEqual([...scopes].sort())
    })

    it('returns added → already_registered → overwritten honestly', () => {
      // First registration: a real add.
      expect(plur.addStore('', 'group:plur/plur-ai/engineering', { url: URL, token: 'tok' }))
        .toEqual({ status: 'added' })
      // Second scope on the same URL: also a real add (the #291 bug).
      expect(plur.addStore('', 'group:plur/plur-ai/comms', { url: URL, token: 'tok' }))
        .toEqual({ status: 'added' })
      // Exact url+scope repeat: idempotent no-op.
      expect(plur.addStore('', 'group:plur/plur-ai/comms', { url: URL, token: 'tok' }))
        .toEqual({ status: 'already_registered' })
      // Same scope reassigned to a different URL with opt-in: overwritten.
      expect(plur.addStore('', 'group:plur/plur-ai/comms', {
        url: 'https://other.example.com', token: 'tok2', overwriteScope: true,
      })).toEqual({ status: 'overwritten' })
    })

    it('same URL + same scope + different token stays an idempotent no-op (no silent token swap)', () => {
      plur.addStore('', 'group:plur/plur-ai/engineering', { url: URL, token: 'original' })
      const result = plur.addStore('', 'group:plur/plur-ai/engineering', { url: URL, token: 'rotated' })

      expect(result).toEqual({ status: 'already_registered' })
      const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
      expect(config.stores).toHaveLength(1)
      expect(config.stores[0].token).toBe('original')
    })
  })

  describe('readonly stores', () => {
    it('readonly remote store is registered and persists the flag', () => {
      plur.addStore('', 'group:ro', {
        url: 'https://readonly.example.com',
        token: 'tok',
        readonly: true,
      })

      const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
      expect(config.stores).toHaveLength(1)
      expect(config.stores[0].readonly).toBe(true)
    })
  })
})
