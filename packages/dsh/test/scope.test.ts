import { describe, expect, it, vi } from 'vitest'
import { createScopeResolver } from '../src/scope.js'

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
    const r = createScopeResolver({ scope: 'project:configured' }, async () => '')
    expect(await r.resolve('a1', '/w/acme')).toBe('project:configured')
  })

  it('derives a readable, path-unique scope when nothing is configured', async () => {
    // Two unconfigured repos must NOT share one pool.
    const r = createScopeResolver({}, async () => undefined)
    expect(await r.resolve('a1', '/work/acme')).toMatch(/^project:acme-[0-9a-f]{6}$/)
    expect(await r.resolve('a2', '/work/zeta')).toMatch(/^project:zeta-[0-9a-f]{6}$/)
  })

  it('does not pool two clients that named their directory the same thing', async () => {
    // `api`, `web`, `server`, `docs` are the common cases, so a bare basename
    // collides in normal use, not in an edge case — one engram pool for two
    // clients, which is the leak this derivation exists to prevent.
    const r = createScopeResolver({}, async () => undefined)
    const acme = await r.resolve('a1', '/clients/acme/api')
    const northwind = await r.resolve('a2', '/clients/northwind/api')
    expect(acme).not.toBe(northwind)
    expect(acme.startsWith('project:api-')).toBe(true)
    expect(northwind.startsWith('project:api-')).toBe(true)
  })

  it('derives the same scope for the same path every time', async () => {
    const r1 = createScopeResolver({}, async () => undefined)
    const r2 = createScopeResolver({}, async () => undefined)
    expect(await r1.resolve('a1', '/work/acme')).toBe(await r2.resolve('other', '/work/acme'))
  })

  it('re-resolves when the same agent moves to another workspace', async () => {
    // The host may reuse an agent id or move it without emitting agent/disposed.
    const r = createScopeResolver({}, async () => undefined)
    expect(await r.resolve('a1', '/work/acme')).toMatch(/^project:acme-/)
    expect(await r.resolve('a1', '/work/zeta')).toMatch(/^project:zeta-/)
  })

  it('clear forgets an agent so a reused id re-resolves', async () => {
    let declared = 'project:first'
    const r = createScopeResolver({ scope: 'project:dsh' }, async () => declared)
    expect(await r.resolve('a1', '/w')).toBe('project:first')
    r.clear('a1')
    declared = 'project:second'
    expect(await r.resolve('a1', '/w')).toBe('project:second')
  })

  it('derives the same scope however the host spells the path', async () => {
    // Hashing the raw cwd meant `/w/proj` and `/w/proj/` were different
    // scopes for the SAME directory: a host that reports a trailing slash, or
    // a symlinked checkout, silently produced a second empty store and two
    // entries in `plur ui`. That is the "why did it forget everything?" bug.
    const { mkdtempSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'scope-'))
    const proj = join(root, 'proj')
    mkdirSync(proj)

    const r = createScopeResolver({}, async () => undefined)
    const forms = [proj, `${proj}/`, `${proj}/.`, join(root, 'other', '..', 'proj')]
    const derived = []
    for (const [i, form] of forms.entries()) derived.push(await r.resolve(`a${i}`, form))
    expect(new Set(derived).size, `forms diverged: ${derived.join(' ')}`).toBe(1)
  })

  it('never derives a scope nobody could type', async () => {
    // basename('/') is '' and basename('/x/.') is '.'.
    const r = createScopeResolver({}, async () => undefined)
    for (const cwd of ['/', '/.']) {
      const scope = await r.resolve(`x${cwd}`, cwd)
      expect(scope, cwd).toMatch(/^project:[A-Za-z0-9._-]+-[0-9a-f]{6}$/)
      expect(scope, cwd).not.toMatch(/^project:[.-]/)
    }
  })
})

