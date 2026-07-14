import { describe, it, expect } from 'vitest'
import { extractExpiry, normalizeIsoDate } from '../src/expiry.js'

// #347 — explicit-expiry extraction. Conservative by design: only an explicit
// expiry keyword immediately followed by an unambiguous, fully-specified date
// produces a match. Anything fuzzy (no year, numeric slash formats, relative
// phrases) returns null — never silently guess.
describe('normalizeIsoDate', () => {
  it('accepts a valid ISO date', () => {
    expect(normalizeIsoDate('2026-05-31')).toBe('2026-05-31')
  })

  it('rejects a non-existent calendar date', () => {
    expect(normalizeIsoDate('2026-02-30')).toBeNull()
  })

  it('rejects malformed strings', () => {
    expect(normalizeIsoDate('31 May 2026')).toBeNull()
    expect(normalizeIsoDate('2026-5-31')).toBeNull()
    expect(normalizeIsoDate('2026/05/31')).toBeNull()
    expect(normalizeIsoDate('')).toBeNull()
    expect(normalizeIsoDate('soon')).toBeNull()
  })
})

describe('extractExpiry', () => {
  it('parses "valid until <ISO date>"', () => {
    const hit = extractExpiry('Discount code SAVE20 is valid until 2026-05-31')
    expect(hit).not.toBeNull()
    expect(hit!.valid_until).toBe('2026-05-31')
    expect(hit!.phrase).toContain('valid until 2026-05-31')
  })

  it('parses "valid until 31 May 2026" (the observed offer-engram shape)', () => {
    const hit = extractExpiry('Offer REV.002 sent 2026-04-28, valid until 31 May 2026')
    expect(hit).not.toBeNull()
    expect(hit!.valid_until).toBe('2026-05-31')
  })

  it('parses bare "valid <date>" (offer shorthand)', () => {
    const hit = extractExpiry('Acme Enterprise offer, valid 31 May 2026')
    expect(hit).not.toBeNull()
    expect(hit!.valid_until).toBe('2026-05-31')
  })

  it('parses "expires <date>" and "expires on <date>"', () => {
    expect(extractExpiry('The token expires 2026-12-01')!.valid_until).toBe('2026-12-01')
    expect(extractExpiry('Cert expires on January 15, 2027')!.valid_until).toBe('2027-01-15')
  })

  it('parses "valid through <date>"', () => {
    expect(extractExpiry('Promo valid through 30 June 2026')!.valid_until).toBe('2026-06-30')
  })

  it('parses "Month D, YYYY" and abbreviated month names', () => {
    expect(extractExpiry('valid until May 31, 2026')!.valid_until).toBe('2026-05-31')
    expect(extractExpiry('expires 1 Jan 2027')!.valid_until).toBe('2027-01-01')
  })

  it('parses ordinal day suffixes', () => {
    expect(extractExpiry('valid until 31st May 2026')!.valid_until).toBe('2026-05-31')
  })

  it('does NOT match "valid from <date>" (that is a start, not an expiry)', () => {
    expect(extractExpiry('Policy valid from 2026-01-01')).toBeNull()
  })

  it('does NOT guess when the year is missing', () => {
    expect(extractExpiry('valid through end of Q2')).toBeNull()
    expect(extractExpiry('expires 31 May')).toBeNull()
  })

  it('does NOT parse ambiguous numeric slash dates', () => {
    expect(extractExpiry('valid until 05/31/2026')).toBeNull()
  })

  it('does NOT match dates without an expiry keyword', () => {
    expect(extractExpiry('Meeting scheduled for 2026-05-31')).toBeNull()
  })

  it('rejects a non-existent calendar date after the keyword', () => {
    expect(extractExpiry('valid until 30 February 2026')).toBeNull()
  })

  it('returns null for statements with no temporal content', () => {
    expect(extractExpiry('API uses snake_case for all endpoints')).toBeNull()
  })
})
