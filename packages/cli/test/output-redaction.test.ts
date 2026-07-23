import { describe, it, expect } from 'vitest'
import { redactSecrets } from '../src/output.js'

describe('redactSecrets', () => {
  it('redacts a token field', () => {
    expect(redactSecrets({ token: 'eyJhbGciOi.secret.value' }))
      .toEqual({ token: '[REDACTED]' })
  })

  it('redacts tokens nested in arrays of stores', () => {
    const input = {
      config: {
        stores: [
          { url: 'https://plur.datafund.io/sse', token: 'eyJabc', scope: 'user:plur:gregor' },
          { path: '/local', scope: 'project:x' },
        ],
      },
      engram_count: 3,
    }
    const out = redactSecrets(input) as any
    expect(out.config.stores[0].token).toBe('[REDACTED]')
    expect(out.config.stores[0].url).toBe('https://plur.datafund.io/sse')
    expect(out.config.stores[1]).not.toHaveProperty('token')
    expect(out.engram_count).toBe(3)
  })

  it('redacts every known secret-bearing key name', () => {
    const out = redactSecrets({
      token: 'a', api_key: 'b', apiKey: 'c', password: 'd',
      secret: 'e', authorization: 'f', refresh_token: 'g',
      access_token: 'h', client_secret: 'i', private_key: 'j',
    }) as Record<string, string>
    for (const [k, v] of Object.entries(out)) {
      expect(v, `key ${k} was not redacted`).toBe('[REDACTED]')
    }
  })

  it('leaves non-secret values untouched', () => {
    const input = { engram_count: 4625, storage_root: '/Users/x/.plur', nested: { ok: true } }
    expect(redactSecrets(input)).toEqual(input)
  })

  it('does not mutate its input', () => {
    const input = { token: 'live-secret' }
    redactSecrets(input)
    expect(input.token).toBe('live-secret')
  })

  it('handles null, undefined and primitives', () => {
    expect(redactSecrets(null)).toBeNull()
    expect(redactSecrets(undefined)).toBeUndefined()
    expect(redactSecrets(42)).toBe(42)
    expect(redactSecrets('plain')).toBe('plain')
  })

  it('terminates on cyclic input', () => {
    const a: any = { token: 'x' }
    a.self = a
    const out = redactSecrets(a) as any
    expect(out.token).toBe('[REDACTED]')
    expect(out.self).toBe('[Circular]')
  })

  // A DAG is not a cycle. Tracking every visited object rather than the current
  // ancestor path would render the second reference as '[Circular]' and silently
  // drop real config (PlurConfig shares sub-objects across store entries).
  it('renders shared references twice rather than calling them circular', () => {
    const shared = { name: 'x' }
    const out = redactSecrets({ a: shared, b: shared }) as any
    expect(out.a).toEqual({ name: 'x' })
    expect(out.b).toEqual({ name: 'x' })
  })

  it('renders a shared array twice', () => {
    const shared = [{ token: 'sensitive' }]
    const out = redactSecrets({ first: shared, second: shared }) as any
    expect(out.first[0].token).toBe('[REDACTED]')
    expect(out.second[0].token).toBe('[REDACTED]')
  })

  it('matches secret key names case-insensitively', () => {
    const out = redactSecrets({ Token: 'a', API_KEY: 'b', Authorization: 'c' }) as Record<string, string>
    expect(Object.values(out)).toEqual(['[REDACTED]', '[REDACTED]', '[REDACTED]'])
  })

  it('redacts a secret key whose value is an object, without descending into it', () => {
    const out = redactSecrets({ token: { nested: 'still-secret' } }) as any
    expect(out.token).toBe('[REDACTED]')
  })

  it('preserves a Date so it still serializes as an ISO string, not {}', () => {
    const d = new Date('2026-01-01T00:00:00.000Z')
    const out = redactSecrets({ created: d, token: 'x' }) as any
    expect(JSON.stringify(out.created)).toBe(JSON.stringify(d))
    expect(out.token).toBe('[REDACTED]')
  })

  it('preserves a Date nested inside an array', () => {
    const d = new Date('2026-01-01T00:00:00.000Z')
    const out = redactSecrets({ items: [d] }) as any
    expect(JSON.stringify(out.items[0])).toBe(JSON.stringify(d))
  })

  it('redacts a token on a class instance, not just plain objects', () => {
    class StoreDriver {
      readonly url = 'https://plur.datafund.io/sse'
      readonly token = 'eyJ-live-credential'
    }
    const out = redactSecrets({ driver: new StoreDriver() }) as any
    expect(out.driver.token).toBe('[REDACTED]')
    expect(out.driver.url).toBe('https://plur.datafund.io/sse')
  })

  it('a class instance with a toJSON serializes itself and is not walked', () => {
    class Money {
      constructor(private cents: number) {}
      toJSON() { return `$${(this.cents / 100).toFixed(2)}` }
    }
    const out = redactSecrets({ price: new Money(1299) }) as any
    expect(out.price).toBeInstanceOf(Money)
    expect(JSON.stringify(out.price)).toBe('"$12.99"')
  })

  it('masks a password embedded in a store URL (key-based redaction can not reach it)', () => {
    const out = redactSecrets({
      stores: [{ url: 'https://gregor:s3cr3tPassw0rd@plur.datafund.io/sse', scope: 'x' }],
    }) as any
    expect(out.stores[0].url).toBe('https://gregor:***@plur.datafund.io/sse')
    expect(out.stores[0].url).not.toContain('s3cr3tPassw0rd')
  })

  it('masks URL userinfo inside an error string', () => {
    const out = redactSecrets({ error: 'failed to add store ftp://user:hunter2@host' }) as any
    expect(out.error).toBe('failed to add store ftp://user:***@host')
    expect(out.error).not.toContain('hunter2')
  })

  it('leaves a plain URL without userinfo untouched', () => {
    const url = 'https://plur.datafund.io/sse'
    expect(redactSecrets({ url })).toEqual({ url })
  })

  it('masks a secret query parameter in a URL string', () => {
    const out = redactSecrets({
      url: 'https://api.example.com/x?token=abc123secret&page=2',
    }) as any
    expect(out.url).toBe('https://api.example.com/x?token=***&page=2')
    expect(out.url).not.toContain('abc123secret')
    expect(out.url).toContain('page=2') // ordinary params untouched
  })

  it('leaves an ordinary query string untouched', () => {
    const url = 'https://x.com/s?q=hello&sort=asc'
    expect(redactSecrets({ url })).toEqual({ url })
  })

  it('redacts the newly-covered secret key names', () => {
    const out = redactSecrets({
      bearer: 'a', jwt: 'b', auth: 'c', cookie: 'd', credential: 'e',
    }) as Record<string, string>
    for (const v of Object.values(out)) expect(v).toBe('[REDACTED]')
  })
})
