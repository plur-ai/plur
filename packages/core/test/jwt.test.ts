/**
 * decodeJwtExpiry — client-side token-expiry inspection (#295).
 * No signature verification; we only read the `exp` claim to warn the user.
 */
import { describe, it, expect } from 'vitest'
import { decodeJwtExpiry } from '../src/jwt.js'

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const makeJwt = (payload: object) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`

const NOW = 1_780_000_000_000 // fixed epoch-ms for deterministic day math

describe('decodeJwtExpiry', () => {
  it('reads a future exp and reports days remaining', () => {
    const exp = Math.floor(NOW / 1000) + 30 * 86_400 // +30 days
    const r = decodeJwtExpiry(makeJwt({ sub: 'x', exp }), NOW)
    expect(r.expired).toBe(false)
    expect(r.expiresInDays).toBe(30)
    expect(r.expiresAt?.getTime()).toBe(exp * 1000)
  })

  it('flags an expired token with negative days', () => {
    const exp = Math.floor(NOW / 1000) - 4 * 86_400 // 4 days ago
    const r = decodeJwtExpiry(makeJwt({ sub: 'x', exp }), NOW)
    expect(r.expired).toBe(true)
    expect(r.expiresInDays).toBe(-4)
  })

  it('returns all-null for an opaque (non-JWT) key like plur_sk_…', () => {
    const r = decodeJwtExpiry('plur_sk_abc123def456', NOW)
    expect(r.expiresAt).toBeNull()
    expect(r.expired).toBe(false)
    expect(r.expiresInDays).toBeNull()
  })

  it('returns all-null for a JWT without an exp claim', () => {
    const r = decodeJwtExpiry(makeJwt({ sub: 'x' }), NOW)
    expect(r.expiresAt).toBeNull()
    expect(r.expiresInDays).toBeNull()
  })

  it('returns all-null for undefined / garbage', () => {
    expect(decodeJwtExpiry(undefined, NOW).expiresAt).toBeNull()
    expect(decodeJwtExpiry('', NOW).expiresAt).toBeNull()
    expect(decodeJwtExpiry('not.a.jwt.with.too.many.parts', NOW).expiresAt).toBeNull()
    expect(decodeJwtExpiry('two.parts', NOW).expiresAt).toBeNull()
  })
})
