import { describe, expect, it, vi } from 'vitest'
import { createScopeResolver } from '../src/scope.ts'

describe('createScopeResolver', () => {
  it('prefers a workspace .plur.yaml scope over the config default', async () => {
    const r = createScopeResolver({ scope: 'project:dsh' }, async () => 'project:acme')
    expect(await r.resolve('a1', '/w/acme')).toBe('project:acme')
  })

  it('falls back to the configured default when the workspace declares none', async () => {
    const r = createScopeResolver({ scope: 'project:dsh' }, async () => undefined)
    expect(await r.resolve('a1', '/w/acme')).toBe('project:dsh')
  })

  it('never returns the ambient global store', async () => {
    const r = createScopeResolver({ scope: 'project:dsh' }, async () => undefined)
    expect(await r.resolve('a1', undefined)).not.toBe('global')
  })

  it('does not consult the workspace when there is no cwd', async () => {
    const read = vi.fn(async () => 'project:acme')
    const r = createScopeResolver({ scope: 'project:dsh' }, read)
    expect(await r.resolve('a1', undefined)).toBe('project:dsh')
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps two concurrent agents on their own scopes', async () => {
    const byCwd: Record<string, string> = { '/w/a': 'project:a', '/w/b': 'project:b' }
    const r = createScopeResolver({ scope: 'project:dsh' }, async cwd => byCwd[cwd])
    const [a, b] = await Promise.all([r.resolve('a1', '/w/a'), r.resolve('a2', '/w/b')])
    expect([a, b]).toEqual(['project:a', 'project:b'])
  })

  it('reads the workspace once per agent, then caches', async () => {
    const read = vi.fn(async () => 'project:acme')
    const r = createScopeResolver({ scope: 'project:dsh' }, read)
    await r.resolve('a1', '/w/acme')
    await r.resolve('a1', '/w/acme')
    expect(read).toHaveBeenCalledOnce()
  })

  it('falls back to the default when the workspace read throws', async () => {
    const r = createScopeResolver({ scope: 'project:dsh' }, async () => { throw new Error('nope') })
    expect(await r.resolve('a1', '/w/acme')).toBe('project:dsh')
  })

  it('ignores an empty declared scope rather than widening to it', async () => {
    const r = createScopeResolver({ scope: 'project:dsh' }, async () => '')
    expect(await r.resolve('a1', '/w/acme')).toBe('project:dsh')
  })

  it('clear forgets an agent so a reused id re-resolves', async () => {
    let declared = 'project:first'
    const r = createScopeResolver({ scope: 'project:dsh' }, async () => declared)
    expect(await r.resolve('a1', '/w')).toBe('project:first')
    r.clear('a1')
    declared = 'project:second'
    expect(await r.resolve('a1', '/w')).toBe('project:second')
  })
})
