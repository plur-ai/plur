import { describe, it, expect } from 'vitest'
import { detectSecrets, detectSensitive, sensitivityCategory } from '../src/secrets.js'

describe('detectSecrets', () => {
  it('detects AWS access keys', () => {
    const matches = detectSecrets('Use key AKIAIOSFODNN7EXAMPLE for S3 access')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('aws_access_key')
  })

  it('detects AWS secret access keys', () => {
    const matches = detectSecrets('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('aws_secret_key')
  })

  it('detects api_key assignments', () => {
    const matches = detectSecrets('Set api_key=abcdef1234567890abcdef1234567890')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('api_key_assignment')
  })

  it('detects generic API keys with sk- prefix', () => {
    const matches = detectSecrets('Set OPENAI_API_KEY=sk-1234567890abcdefghijklmn')
    expect(matches.length).toBeGreaterThan(0)
  })

  it('detects password assignments', () => {
    const matches = detectSecrets('database password = hunter2secret')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('password_assignment')
  })

  it('detects connection strings', () => {
    const matches = detectSecrets('Connect to postgres://user:pass@host:5432/db')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('connection_string')
  })

  it('detects JWTs', () => {
    const matches = detectSecrets('Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('jwt')
  })

  it('detects private key blocks', () => {
    const matches = detectSecrets('-----BEGIN RSA PRIVATE KEY-----')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('private_key')
  })

  it('detects bearer tokens', () => {
    const matches = detectSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890')
    expect(matches.length).toBeGreaterThan(0)
  })

  it('returns empty for clean statements', () => {
    const matches = detectSecrets('Always use HTTPS for API calls')
    expect(matches).toHaveLength(0)
  })

  it('returns empty for statements about keys without actual keys', () => {
    const matches = detectSecrets('Store API keys in environment variables, never in code')
    expect(matches).toHaveLength(0)
  })

  // Issue #231 — detectSecrets used to crash with cryptic
  // "Cannot read properties of undefined (reading 'match')" when called with
  // a non-string. Now throws a clear TypeError at the front door.
  it('throws TypeError when called with undefined (#231)', () => {
    expect(() => detectSecrets(undefined as unknown as string))
      .toThrow(/expected string, got undefined/)
  })

  it('throws TypeError when called with a number (#231)', () => {
    expect(() => detectSecrets(42 as unknown as string))
      .toThrow(/expected string, got number/)
  })
})

// Detector hardening — Stage 1.5b (#353). These detectors GATE the publish
// filter and trigger write-time scope-demotion, so the overriding constraint is
// LOW FALSE POSITIVES: a false match silently demotes a legitimate engram on
// every shared-scope write. The negative cases below are the load-bearing half.
describe('detectSensitive — public IPv6 (infra)', () => {
  const has = (text: string, pattern: string) =>
    detectSensitive(text).some(m => m.pattern === pattern)

  it('flags a globally-routable (global unicast 2000::/3) address', () => {
    expect(has('dns is at 2001:4860:4860::8888', 'public_ipv6')).toBe(true)
  })

  it('classifies public_ipv6 as infra', () => {
    expect(sensitivityCategory('public_ipv6')).toBe('infra')
  })

  it('does NOT flag loopback ::1', () => {
    expect(has('bind to ::1 for local only', 'public_ipv6')).toBe(false)
  })

  it('does NOT flag link-local fe80::/10', () => {
    expect(has('interface addr fe80::1', 'public_ipv6')).toBe(false)
  })

  it('does NOT flag unique-local / ULA fd00::/8', () => {
    expect(has('ula prefix fd00::1', 'public_ipv6')).toBe(false)
  })

  it('does NOT flag the documentation prefix 2001:db8::/32', () => {
    expect(has('example doc addr 2001:db8::1', 'public_ipv6')).toBe(false)
  })

  it('does NOT flag a MAC address (six 2-hex groups)', () => {
    expect(has('mac 00:11:22:33:44:55', 'public_ipv6')).toBe(false)
  })

  it('does NOT flag a clock time', () => {
    expect(has('meeting at 12:30:45 today', 'public_ipv6')).toBe(false)
  })
})

describe('detectSensitive — internal hosts (infra)', () => {
  const has = (text: string, pattern: string) =>
    detectSensitive(text).some(m => m.pattern === pattern)

  it('flags an .internal.corp suffix host', () => {
    expect(has('connect to db.internal.corp', 'internal_host')).toBe(true)
  })

  it('flags a k8s .svc.cluster.local host', () => {
    expect(has('svc.prod.svc.cluster.local is the target', 'internal_host')).toBe(true)
  })

  it('flags a bare .internal suffix host', () => {
    expect(has('redis.internal handles the cache', 'internal_host')).toBe(true)
  })

  it('flags a hostname with a staging label', () => {
    expect(has('the box is hub-staging.plur.ai', 'internal_host')).toBe(true)
  })

  it('flags staging as an inner label', () => {
    expect(has('api.staging.example.com is pre-prod', 'internal_host')).toBe(true)
  })

  it('classifies internal_host as infra', () => {
    expect(sensitivityCategory('internal_host')).toBe('infra')
  })

  it('does NOT flag ordinary public FQDNs', () => {
    expect(has('see example.com for details', 'internal_host')).toBe(false)
    expect(has('docs at https://google.com/path', 'internal_host')).toBe(false)
    expect(has('the api.github.com endpoint', 'internal_host')).toBe(false)
  })

  it('does NOT flag an email address', () => {
    expect(has('email user@example.com', 'internal_host')).toBe(false)
  })

  it('does NOT flag localhost or standalone infra words', () => {
    expect(has('runs on localhost', 'internal_host')).toBe(false)
    expect(has('check the db and redis on prod', 'internal_host')).toBe(false)
  })

  it('does NOT flag staging as a bare prose word', () => {
    expect(has('the staging build failed', 'internal_host')).toBe(false)
  })
})

describe('detectSensitive — false-positive safety (must stay clean)', () => {
  // The single most important assertion set: none of these benign strings may
  // produce ANY detectSensitive hit, or the leak guard demotes legitimate
  // engrams on every shared-scope write.
  const clean = [
    '::1',
    'fe80::1',
    'fd00::1',
    '2001:db8::1', // IPv6 documentation prefix
    '00:11:22:33:44:55', // MAC address
    '12:30:45', // clock time
    '1.2.3', // semver
    'example.com',
    'https://google.com/path',
    'api.github.com',
    'user@example.com',
    'localhost',
    '550e8400-e29b-41d4-a716-446655440000', // UUID
  ]
  for (const text of clean) {
    it(`stays clean: ${text}`, () => {
      expect(detectSensitive(text)).toHaveLength(0)
    })
  }
})
