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
})
