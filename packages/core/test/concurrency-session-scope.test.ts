/**
 * Session-scope isolation under interleaved calls (convergence Phase 2).
 *
 * These tests are only meaningful because they INTERLEAVE. Awaiting two calls
 * one after the other proves nothing here: the defect is that a session's
 * default scope lived in one field shared by the whole instance, so it can only
 * be observed when a second session mutates that field while a first session's
 * `async` write is suspended at an await. Every test below forces exactly that
 * suspension point.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { SessionScopeRegistry } from '../src/session-scopes.js'

describe('SessionScopeRegistry', () => {
  it('isolates registered sessions from each other and from the process slot', () => {
    const r = new SessionScopeRegistry()
    r.set('group:acme/eng')
    r.set('user:a', 'sess-a')
    r.set('user:b', 'sess-b')

    expect(r.get('sess-a')).toBe('user:a')
    expect(r.get('sess-b')).toBe('user:b')
    // Unregistered session inherits the process slot — the pre-existing
    // single-session behaviour.
    expect(r.get('sess-c')).toBe('group:acme/eng')
    expect(r.get()).toBe('group:acme/eng')
  })

  it('distinguishes "registered as null" from "never registered"', () => {
    const r = new SessionScopeRegistry()
    r.set('group:acme/eng')
    r.set(null, 'sess-optout')

    // Explicit null pins the session to no-session-scope: unscoped writes
    // auto-route rather than inheriting the process default.
    expect(r.get('sess-optout')).toBeNull()
    expect(r.get('sess-other')).toBe('group:acme/eng')
  })

  it('clears a session without touching the process slot', () => {
    const r = new SessionScopeRegistry()
    r.set('global')
    r.set('user:a', 'sess-a')
    r.clear('sess-a')
    expect(r.trackedSessions).toEqual([])
    expect(r.get('sess-a')).toBe('global')
    expect(r.get()).toBe('global')
  })
})

describe('Plur — concurrent session scopes', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-session-scope-'))
    plur = new Plur({ path: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not bleed scope between two interleaved learnRouted calls', async () => {
    plur.setSessionScope('project:alpha', { session: 's1' })
    plur.setSessionScope('project:beta', { session: 's2' })

    // Interleave deliberately: kick both off, let the event loop hand control
    // back and forth, and only then await. With a shared `_sessionScope` field
    // the second `setSessionScope` above would already have decided both.
    const [a, b] = await Promise.all([
      (async () => {
        await new Promise(r => setImmediate(r))
        return plur.learnRouted('alpha uses pnpm for the monorepo', { session: 's1' })
      })(),
      (async () => {
        return plur.learnRouted('beta uses cargo for the workspace', { session: 's2' })
      })(),
    ])

    expect(a.scope).toBe('project:alpha')
    expect(b.scope).toBe('project:beta')
  })

  it('keeps scopes apart across a fan-out of sessions writing at once', async () => {
    const sessions = Array.from({ length: 8 }, (_, i) => `s${i}`)
    for (const s of sessions) plur.setSessionScope(`project:p${s}`, { session: s })

    const engrams = await Promise.all(
      sessions.map((s, i) =>
        (async () => {
          // Stagger the suspension points so the calls genuinely interleave
          // rather than each running to completion in its own turn.
          for (let k = 0; k < i; k++) await new Promise(r => setImmediate(r))
          return plur.learnRouted(`session ${s} prefers convention number ${i}`, { session: s })
        })(),
      ),
    )

    for (let i = 0; i < sessions.length; i++) {
      expect(engrams[i].scope).toBe(`project:p${sessions[i]}`)
    }
    // And every one of them actually persisted — no lost writes.
    const stored = plur.list()
    for (const e of engrams) {
      expect(stored.find(s => s.id === e.id)?.scope).toBe(e.scope)
    }
  })

  it('a session registered after another session started still does not affect it', async () => {
    plur.setSessionScope('project:first', { session: 'sA' })

    let released!: () => void
    const gate = new Promise<void>(r => { released = r })

    const first = (async () => {
      await gate
      return plur.learnRouted('the first session records its own convention', { session: 'sA' })
    })()

    // While sA is suspended, a brand-new session registers a different scope
    // and writes. Under the old shared field this is the exact clobber.
    plur.setSessionScope('project:second', { session: 'sB' })
    const second = await plur.learnRouted('the second session records another convention', { session: 'sB' })
    released()

    const a = await first
    expect(a.scope).toBe('project:first')
    expect(second.scope).toBe('project:second')
  })

  it('unkeyed setSessionScope still governs unkeyed writes (back-compat)', async () => {
    plur.setSessionScope('project:legacy')
    const e = await plur.learnRouted('legacy callers pass no session key at all')
    expect(e.scope).toBe('project:legacy')
    expect(plur.getSessionScope()).toBe('project:legacy')
  })

  it('an unregistered session inherits the process slot', async () => {
    plur.setSessionScope('project:legacy')
    const e = await plur.learnRouted('an unregistered session still sees the process default', { session: 'ghost' })
    expect(e.scope).toBe('project:legacy')
  })

  it('clearSessionScope drops only the named session', async () => {
    plur.setSessionScope('project:default')
    plur.setSessionScope('project:owned', { session: 'sX' })
    expect(plur.trackedSessionScopes()).toEqual(['sX'])

    plur.clearSessionScope({ session: 'sX' })
    expect(plur.trackedSessionScopes()).toEqual([])
    const e = await plur.learnRouted('after clearing, the session falls back to the process slot', { session: 'sX' })
    expect(e.scope).toBe('project:default')
  })

  it('an explicit context.scope always wins over the session scope', async () => {
    plur.setSessionScope('project:session', { session: 's1' })
    const e = await plur.learnRouted('explicit scope beats the session default', {
      session: 's1',
      scope: 'project:explicit',
    })
    expect(e.scope).toBe('project:explicit')
  })

  it('does not persist the session key onto the engram', async () => {
    plur.setSessionScope('project:alpha', { session: 's1' })
    const e = await plur.learnRouted('the session key selects a scope, it is not part of one', { session: 's1' })
    expect((e as unknown as Record<string, unknown>).session).toBeUndefined()
    const reloaded = plur.getById(e.id)
    expect((reloaded as unknown as Record<string, unknown>).session).toBeUndefined()
  })
})
