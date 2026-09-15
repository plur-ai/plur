import { describe, it, expect } from 'vitest'
import { resolveScopeRoot } from '../src/scope.js'

describe('resolveScopeRoot', () => {
  it('prefers a real worktree when there is one', () => {
    expect(resolveScopeRoot({ directory: '/repo/sub', worktree: '/repo' })).toBe('/repo')
  })

  it('ignores worktree "/" — measured in non-git dirs', () => {
    expect(resolveScopeRoot({ directory: '/tmp/work', worktree: '/' })).toBe('/tmp/work')
  })

  it('ignores an empty worktree', () => {
    expect(resolveScopeRoot({ directory: '/tmp/work', worktree: '' })).toBe('/tmp/work')
  })

  it('falls back to cwd when neither is usable', () => {
    expect(resolveScopeRoot({})).toBe(process.cwd())
  })
})
