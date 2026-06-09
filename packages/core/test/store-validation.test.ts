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

    // Issue #291 — same URL with different scope must create separate entries
    it('allows multiple scopes for the same URL (multi-team users) (#291)', () => {
      plur.addStore('', 'group:plur/engineering', { url: 'https://plur.datafund.io', token: 'tok' })
      const result = plur.addStore('', 'group:plur/comms', { url: 'https://plur.datafund.io', token: 'tok' })

      // Second add should succeed and return 'added' status
      expect(result?.status).toBe('added')

      const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
      expect(config.stores).toHaveLength(2)
      expect(config.stores.map((s: any) => s.scope)).toContain('group:plur/engineering')
      expect(config.stores.map((s: any) => s.scope)).toContain('group:plur/comms')
    })

    it('returns already_registered for duplicate URL + scope (#291)', () => {
      plur.addStore('', 'group:test', { url: 'https://plur.datafund.io', token: 'tok' })
      const result = plur.addStore('', 'group:test', { url: 'https://plur.datafund.io', token: 'tok' })

      expect(result?.status).toBe('already_registered')

      const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
      expect(config.stores).toHaveLength(1)
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
