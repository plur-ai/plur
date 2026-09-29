/**
 * Decision E7 (owner, 2026-09-26): `NO_SESSION` sentinel.
 *
 * A learn / learnRouted / recall whose `session` is `NO_SESSION` uses NO
 * session default — neither a keyed registration nor the process-default slot —
 * so an unscoped write takes the genuinely-unscoped path (auto-route /
 * unscoped_default, scope_source 'routed' | 'default').
 *
 * Local only: no remote store, nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, NO_SESSION, SessionScopeRegistry } from '../src/index.js'

describe('Decision E7 — NO_SESSION ignores every session default', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-apply-nosession-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, unscoped_default: 'local' }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is exported as a string constant', () => {
    expect(typeof NO_SESSION).toBe('string')
  })

  it('the registry answers null for NO_SESSION even with a process default and keyed registrations', () => {
    const r = new SessionScopeRegistry()
    r.set('group:acme/team')
    r.set('project:x', 'sess-1')
    expect(r.get(NO_SESSION)).toBeNull()
    expect(r.get(undefined)).toBe('group:acme/team')
    expect(r.get('sess-2')).toBe('group:acme/team')
  })

  it('refuses to register a scope under NO_SESSION (it can never be read back)', () => {
    const r = new SessionScopeRegistry()
    expect(() => r.set('project:x', NO_SESSION)).toThrow(/NO_SESSION/)
    r.clear(NO_SESSION) // no-op, never throws
  })

  it('learn(): an unscoped write with NO_SESSION ignores the process-default slot', async () => {
    const plur = new Plur({ path: dir })
    plur.setSessionScope('project:team-default')
    const withDefault = await plur.learn('with the process default in effect', { type: 'behavioral' })
    expect(withDefault.scope).toBe('project:team-default')
    const none = await plur.learn('no session at all', { type: 'behavioral', session: NO_SESSION })
    expect(none.scope).toBe('local')
    expect((none.structured_data as any)?._scopeSource).toBe('default')
  })

  it('learnRouted(): an unscoped write with NO_SESSION takes the unscoped path', async () => {
    const plur = new Plur({ path: dir })
    plur.setSessionScope('project:team-default')
    const e = await plur.learnRouted('an unscoped write from a client with no session id', {
      type: 'behavioral', session: NO_SESSION,
    })
    expect(e.scope).toBe('local')
    expect((e.structured_data as any)?._scopeSource).toBe('default')
    // An explicit scope still wins.
    const x = await plur.learnRouted('explicitly scoped', { type: 'behavioral', scope: 'project:y', session: NO_SESSION })
    expect(x.scope).toBe('project:y')
  })
})
