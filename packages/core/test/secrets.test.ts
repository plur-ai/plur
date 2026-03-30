import { describe, it, expect } from 'vitest'
import { detectSecrets } from '../src/secrets.js'

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
})
