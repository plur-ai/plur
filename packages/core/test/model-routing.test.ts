import { describe, it, expect } from 'vitest'
import { selectModel, resolveOperationTier, selectModelForOperation } from '../src/model-routing.js'

describe('selectModel', () => {
  it('returns default for fast', () => { expect(selectModel('fast')).toBe('claude-haiku-4-0') })
  it('returns default for balanced', () => { expect(selectModel('balanced')).toBe('claude-sonnet-4-20250514') })
  it('returns default for thorough', () => { expect(selectModel('thorough')).toBe('claude-opus-4-20250514') })
  it('accepts custom map', () => { expect(selectModel('fast', { fast: 'gpt-4o-mini' })).toBe('gpt-4o-mini') })
})

describe('resolveOperationTier', () => {
  it('returns defaults', () => {
    expect(resolveOperationTier('dedup')).toBe('fast')
    expect(resolveOperationTier('profile')).toBe('balanced')
    expect(resolveOperationTier('meta')).toBe('thorough')
  })
  it('respects overrides', () => {
    expect(resolveOperationTier('dedup', { dedup_tier: 'thorough' })).toBe('thorough')
  })
})

describe('selectModelForOperation', () => {
  it('resolves through tier', () => {
    expect(selectModelForOperation('dedup')).toBe('claude-haiku-4-0')
    expect(selectModelForOperation('meta')).toBe('claude-opus-4-20250514')
  })
})
