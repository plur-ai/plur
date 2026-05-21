/**
 * Unit tests for storePrefix and ID prefix round-trip.
 * These ensure the namespace prefix added by _loadAllEngrams can be
 * correctly stripped by _stripRemotePrefix before sending to remote servers.
 * See: https://github.com/plur-ai/plur/issues/86
 */
import { describe, it, expect } from 'vitest'
import { storePrefix } from '../src/engrams.js'

describe('storePrefix', () => {
  it('group:plur/plur-ai/engineering → GPL', () => {
    expect(storePrefix('group:plur/plur-ai/engineering')).toBe('GPL')
  })

  it('project:plur → PPL', () => {
    expect(storePrefix('project:plur')).toBe('PPL')
  })

  it('project:Data → PDA', () => {
    expect(storePrefix('project:Data')).toBe('PDA')
  })

  it('global → GBL', () => {
    expect(storePrefix('global')).toBe('GBL')
  })

  it('group:datafund → GDA', () => {
    expect(storePrefix('group:datafund')).toBe('GDA')
  })

  it('single short word → padded', () => {
    // "ab" → A + B + A (padded)
    expect(storePrefix('ab')).toBe('ABA')
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
    expect(prefixed).toBe('ENG-GPL-2026-05-19-004')
    expect(stripPrefix(prefixed, scope)).toBe(original)
  })

  it('ABS ID round-trips through prefix/strip', () => {
    const original = 'ABS-2026-0501-001'
    const scope = 'project:plur'
    const prefixed = addPrefix(original, scope)
    expect(prefixed).toBe('ABS-PPL-2026-0501-001')
    expect(stripPrefix(prefixed, scope)).toBe(original)
  })

  it('META ID round-trips through prefix/strip', () => {
    const original = 'META-2026-0501-001'
    const scope = 'group:datafund'
    const prefixed = addPrefix(original, scope)
    expect(prefixed).toBe('META-GDA-2026-0501-001')
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
