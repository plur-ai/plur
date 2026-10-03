/**
 * The namespace prefix names one store (0.21.1 audit of PR #1570, H1).
 *
 * Three letters from the scope gave every team store of one org the same
 * prefix (`group:plur/eng` and `group:plur/ops` were both `GPL`). The prefix
 * now carries a short stable digest of the whole scope, and every helper that
 * reads ids accepts both forms.
 */
import { describe, it, expect } from 'vitest'
import { storePrefix, namespaceEngramId, bareEngramId } from '../src/index.js'

describe('storePrefix is unique per store scope', () => {
  it('two team scopes of one org get different prefixes', () => {
    expect(storePrefix('group:plur/eng')).not.toBe(storePrefix('group:plur/ops'))
    expect(storePrefix('group:plur/plur-ai/engineering')).not.toBe(storePrefix('group:plur/plur-ai/comms'))
  })

  it('is stable, uppercase letters only, and keeps the readable three-letter start', () => {
    const p = storePrefix('group:plur/eng')
    expect(storePrefix('group:plur/eng')).toBe(p)
    expect(p).toMatch(/^[A-Z]{11}$/)
    expect(p.startsWith('GPL')).toBe(true)
  })

  it('no collisions across a realistic set of scopes', () => {
    const scopes = [
      'group:plur/plur-ai', 'group:plur/plur-ai/comms', 'group:plur/plur-ai/engineering',
      'group:plur/plur-ai/leadership', 'group:plur/plur-ai/research', 'group:plur/engineering',
      'project:plur/plur-ai/plur', 'project:plur/plur-ai/plur-bench', 'project:plur/plur-ai/engram-spec',
      'user:plur:someone', 'datafund', 'project:myapp', 'group:test', 'group:acme/eng', 'group:acme/ops',
    ]
    const prefixes = new Set(scopes.map(storePrefix))
    expect(prefixes.size).toBe(scopes.length)
  })
})

describe('id helpers accept both prefix forms', () => {
  const scope = 'group:plur/ops'

  it('bareEngramId strips the new and the old prefix', () => {
    const bare = 'ENG-2026-10-03-001'
    expect(bareEngramId(namespaceEngramId(bare, scope))).toBe(bare)
    expect(bareEngramId('ENG-GPL-2026-10-03-001')).toBe(bare)
    expect(bareEngramId(bare)).toBe(bare)
  })

  it('namespaceEngramId is idempotent and upgrades an old-form id of the same scope', () => {
    const bare = 'ENG-2026-10-03-001'
    const ns = namespaceEngramId(bare, scope)
    expect(ns).toBe(`ENG-${storePrefix(scope)}-2026-10-03-001`)
    expect(namespaceEngramId(ns, scope)).toBe(ns)
    expect(namespaceEngramId('ENG-GPL-2026-10-03-001', scope)).toBe(ns)
  })
})
