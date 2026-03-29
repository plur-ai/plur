import { describe, it, expect } from 'vitest'
import { shouldOutputJson, type OutputOptions } from '../src/output.js'

describe('output', () => {
  it('returns true when json flag is set', () => {
    expect(shouldOutputJson({ json: true })).toBe(true)
  })

  it('returns false when json flag is explicitly false', () => {
    expect(shouldOutputJson({ json: false })).toBe(false)
  })
})
