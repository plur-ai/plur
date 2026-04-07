import { describe, it, expect } from 'vitest'
import { buildAuthHeader } from '../src/register.js'

describe('buildAuthHeader', () => {
  it('returns null for undefined input', () => {
    expect(buildAuthHeader(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(buildAuthHeader('')).toBeNull()
  })

  it('returns null for input without colon', () => {
    expect(buildAuthHeader('justuser')).toBeNull()
  })

  it('encodes user:password as Basic base64', () => {
    const header = buildAuthHeader('team:datahub')
    expect(header).toBe('Basic ' + Buffer.from('team:datahub').toString('base64'))
    // Verify the encoded form decodes back
    const encoded = header!.replace('Basic ', '')
    expect(Buffer.from(encoded, 'base64').toString('utf-8')).toBe('team:datahub')
  })

  it('handles passwords with colons (encodes everything after first colon as part of password)', () => {
    const header = buildAuthHeader('user:pass:with:colons')
    expect(header).toBe('Basic ' + Buffer.from('user:pass:with:colons').toString('base64'))
  })

  it('handles unicode in credentials', () => {
    const header = buildAuthHeader('user:påsswörd')
    expect(header).toBe('Basic ' + Buffer.from('user:påsswörd', 'utf-8').toString('base64'))
  })
})
