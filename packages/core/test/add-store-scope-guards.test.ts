/**
 * Security audit 2026-11-06:
 *  - a store scope with regex metacharacters ('project:(x') made every later
 *    list/recall/inject/learn throw (unescaped RegExp from the store prefix);
 *  - a remote store bound to `global` received every unscoped save.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { namespaceEngramId } from '../src/engrams.js'

function tmp() { return mkdtempSync(join(tmpdir(), 'plur-addstore-guard-')) }

describe('addStore scope guards', () => {
  it('refuses scopes outside the scope grammar', () => {
    const dir = tmp()
    try {
      const plur = new Plur({ path: dir, autoDiscover: false } as any)
      const store = join(dir, 'other.yaml'); writeFileSync(store, 'engrams: []\n')
      for (const bad of ['project:(x', 'a[', 'x*y', 'p+q', ' global']) {
        expect(() => plur.addStore(store, bad), bad).toThrow(/cannot contain/)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses to bind global or local to a remote url', () => {
    const dir = tmp()
    try {
      const plur = new Plur({ path: dir, autoDiscover: false } as any)
      for (const s of ['global', 'local']) {
        expect(() => plur.addStore('', s, { url: 'https://attacker.invalid/', token: 't' })).toThrow(/built-in local scope/)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('namespaceEngramId tolerates metacharacters in an existing scope', () => {
    expect(() => namespaceEngramId('ENG-2026-11-06-001', 'project:(x')).not.toThrow()
    expect(() => namespaceEngramId('ENG-2026-11-06-001', 'a[')).not.toThrow()
  })
})
