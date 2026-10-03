/**
 * Unit tests for storePrefix and ID prefix round-trip.
 * These ensure the namespace prefix added by _loadAllEngrams can be
 * correctly stripped by _stripRemotePrefix before sending to remote servers.
 * See: https://github.com/plur-ai/plur/issues/86
 */
import { describe, it, expect } from 'vitest'
import { storePrefix, legacyStorePrefix, bareEngramId } from '../src/engrams.js'

describe('bareEngramId (#1119)', () => {
  it('strips group:plur GPL prefix to bare ID', () => {
    expect(bareEngramId('ENG-GPL-2026-08-13-025')).toBe('ENG-2026-08-13-025')
  })

  it('strips other store prefixes (DFU, PMY, GBL)', () => {
    expect(bareEngramId('ENG-DFU-2026-04-01-001')).toBe('ENG-2026-04-01-001')
    expect(bareEngramId('ENG-PMY-2026-09-02-003')).toBe('ENG-2026-09-02-003')
    expect(bareEngramId('ENG-GBL-2026-01-15-010')).toBe('ENG-2026-01-15-010')
  })

  it('leaves already bare IDs unchanged', () => {
    expect(bareEngramId('ENG-2026-08-13-025')).toBe('ENG-2026-08-13-025')
    expect(bareEngramId('ABS-2026-0501-001')).toBe('ABS-2026-0501-001')
  })

  it('works with ABS and META prefixes', () => {
    expect(bareEngramId('ABS-GPL-2026-08-13-025')).toBe('ABS-2026-08-13-025')
    expect(bareEngramId('META-GDA-2026-0501-001')).toBe('META-2026-0501-001')
  })

  it('does not mangle server, cold, or pack engram shapes (#1119)', () => {
    expect(bareEngramId('ENG-SRV-001')).toBe('ENG-SRV-001')
    expect(bareEngramId('ENG-COLD-001')).toBe('ENG-COLD-001')
    expect(bareEngramId('ENG-PACK-EM-006')).toBe('ENG-PACK-EM-006')
  })
})

// The three-letter derivation is kept as legacyStorePrefix (ids in that form
// are still read); storePrefix adds four letters of a scope digest (0.21.1, H1).
describe('legacyStorePrefix, and storePrefix starting with it', () => {
  it('group:plur/plur-ai/engineering → GPL', () => {
    expect(legacyStorePrefix('group:plur/plur-ai/engineering')).toBe('GPL')
    expect(storePrefix('group:plur/plur-ai/engineering')).toMatch(new RegExp(`^${'GPL'}[A-Z]{4}$`))
  })

  it('project:plur → PPL', () => {
    expect(legacyStorePrefix('project:plur')).toBe('PPL')
    expect(storePrefix('project:plur')).toMatch(new RegExp(`^${'PPL'}[A-Z]{4}$`))
  })

  it('project:Data → PDA', () => {
    expect(legacyStorePrefix('project:Data')).toBe('PDA')
    expect(storePrefix('project:Data')).toMatch(new RegExp(`^${'PDA'}[A-Z]{4}$`))
  })

  it('global → GBL', () => {
    expect(legacyStorePrefix('global')).toBe('GBL')
    expect(storePrefix('global')).toMatch(new RegExp(`^${'GBL'}[A-Z]{4}$`))
  })

  it('group:datafund → GDA', () => {
    expect(legacyStorePrefix('group:datafund')).toBe('GDA')
    expect(storePrefix('group:datafund')).toMatch(new RegExp(`^${'GDA'}[A-Z]{4}$`))
  })

  it('single short word → padded', () => {
    // "ab" → A + B + A (padded)
    expect(legacyStorePrefix('ab')).toBe('ABA')
    expect(storePrefix('ab')).toMatch(new RegExp(`^${'ABA'}[A-Z]{4}$`))
  })
})

describe('ID prefix round-trip', () => {
  // Simulates what _loadAllEngrams does (add prefix) and what
  // _stripRemotePrefix should undo (strip prefix)
  const addPrefix = (id: string, scope: string): string => {
    const prefix = storePrefix(scope)
    return id.replace(/^(ENG|ABS|META)-/, `$1-${prefix}-`)
  }

  const stripPrefix = (id: string, scope: string): string => {
    const prefix = storePrefix(scope)
    const nsPattern = new RegExp(`^(ENG|ABS|META)-${prefix}-`)
    if (nsPattern.test(id)) {
      return id.replace(nsPattern, '$1-')
    }
    return id
  }

  it('ENG ID round-trips through prefix/strip', () => {
    const original = 'ENG-2026-05-19-004'
    const scope = 'group:plur/plur-ai/engineering'
    const prefixed = addPrefix(original, scope)
    expect(prefixed).toBe(`ENG-${storePrefix(scope)}-2026-05-19-004`)
    expect(prefixed.startsWith('ENG-GPL')).toBe(true)
    expect(stripPrefix(prefixed, scope)).toBe(original)
  })

  it('ABS ID round-trips through prefix/strip', () => {
    const original = 'ABS-2026-0501-001'
    const scope = 'project:plur'
    const prefixed = addPrefix(original, scope)
    expect(prefixed).toBe(`ABS-${storePrefix(scope)}-2026-0501-001`)
    expect(stripPrefix(prefixed, scope)).toBe(original)
  })

  it('META ID round-trips through prefix/strip', () => {
    const original = 'META-2026-0501-001'
    const scope = 'group:datafund'
    const prefixed = addPrefix(original, scope)
    expect(prefixed).toBe(`META-${storePrefix(scope)}-2026-0501-001`)
    expect(stripPrefix(prefixed, scope)).toBe(original)
  })

  it('strip with wrong scope returns ID unchanged', () => {
    const prefixed = 'ENG-GPL-2026-05-19-004'
    // Wrong scope — prefix doesn't match
    expect(stripPrefix(prefixed, 'project:plur')).toBe(prefixed)
  })

  it('strip on already-unprefixed ID returns it unchanged', () => {
    const original = 'ENG-2026-05-19-004'
    expect(stripPrefix(original, 'group:plur/plur-ai/engineering')).toBe(original)
  })
})
