import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { cfg } from './helpers/config.js'

describe('Config', () => {
  it('defaults injection on, in content mode', () => {
    const c = cfg({})
    expect(c.injectionMode).toBe('content')
    expect(c.injectionBudget).toBe(2000)
  })

  it('leaves scope UNSET so it derives per workspace', () => {
    // A single shared default would put every unconfigured repository into one
    // engram pool — a cross-project leak. Derivation happens in scope.ts.
    expect(cfg({}).scope).toBeUndefined()
  })

  it('honours an explicit scope, and never the ambient global store', () => {
    expect(cfg({ scope: 'project:acme' }).scope).toBe('project:acme')
  })

  it('rejects a non-positive timeout', () => {
    expect(() => cfg({ timeoutMs: 0 })).toThrow()
  })

  it('rejects an unknown injection mode', () => {
    expect(() => cfg({ injectionMode: 'cue' as never })).toThrow()
  })

  it('leaves auto-learn and auto-capture on by default', () => {
    const c = cfg({})
    expect(c.autoLearn).toBe(true)
    expect(c.autoCapture).toBe(true)
  })

  it('defaults the reranker off — bge peaks at ~2GB RSS and this runs in the host process', () => {
    expect(cfg({}).reranker).toBe('off')
  })
})
