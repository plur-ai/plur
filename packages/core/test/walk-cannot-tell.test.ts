/**
 * #907 — a routing walk must not read "could not look" as "not here".
 *
 * Both walks decided store ownership with `getById`, which catches everything
 * and returns null. So a timeout, a 5xx or an auth rejection was
 * indistinguishable from a genuine 404: the walk moved on, and after every
 * store reported "Engram not found" — for an engram the store demonstrably
 * held. `plur_recall` returned it from that same remote while `plur_feedback`
 * denied it existed.
 *
 * That is the exact collapse `existsById` exists to prevent, one layer above
 * where anyone had looked: the guards used it, the walks that actually decide
 * ownership did not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

const REMOTE = 'https://remote.example.com/sse'
const SCOPE = 'group:acme/team'

describe('an unreachable store is not reported as "not found" (#907)', () => {
  let dir: string
  let plur: Plur
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-907-'))
    writeFileSync(join(dir, 'config.yaml'), JSON.stringify({
      stores: [{ url: REMOTE, token: 'tok', scope: SCOPE, shared: true, readonly: false }],
      index: false,
    }))
    originalFetch = globalThis.fetch
    plur = new Plur({ path: dir })
  })
  afterEach(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

  it('says the store could not be reached, instead of claiming absence', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as never

    const message = await plur.feedback('ENG-GPL-2026-08-13-025', 'positive').then(
      () => 'resolved', (e: Error) => e.message,
    )

    expect(message, 'a bare "not found" claims a search that did not happen')
      .toMatch(/could not be reached/)
    expect(message).toContain(SCOPE)
  })

  it('still reports a plain "not found" when every store answered', async () => {
    // The control. An authoritative 404 from a reachable store IS absence, and
    // must not be dressed up as uncertainty — that would be the same defect
    // pointing the other way.
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 404,
      json: async (): Promise<unknown> => null,
      text: async (): Promise<string> => '',
    } as unknown as Response)) as never

    const message = await plur.feedback('ENG-GPL-2026-08-13-025', 'positive').then(
      () => 'resolved', (e: Error) => e.message,
    )
    expect(message).toMatch(/Engram not found/)
    expect(message, 'a reachable 404 must read as absence, not as uncertainty')
      .not.toMatch(/could not be reached/)
  })
  it('forget records an unreachable store instead of claiming plain absence', async () => {
    // The destructive path. It still CONTINUES the walk — `forget handles
    // remote server error gracefully` (#84) asserts a degraded fleet must not
    // stop a retire, and that availability is worth keeping. What changes is
    // that the terminal message can no longer claim absence it never verified.
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as never

    const message = await plur.forget('ENG-GPL-2026-08-13-025', 'testing', { force: true }).then(
      () => 'retired', (e: Error) => e.message,
    )
    expect(message, 'the phrase the #84 contract and its test depend on').toContain('Engram not found')
    expect(message, 'a bare "not found" claims a search that did not happen')
      .toMatch(/could not be reached/)
    expect(message).toContain(SCOPE)
  })

  it('forget still reports plain absence when every store answered 404', async () => {
    // The control, on the destructive side: a reachable 404 IS absence and
    // must not be dressed up as uncertainty.
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 404,
      json: async (): Promise<unknown> => null,
      text: async (): Promise<string> => '',
    } as unknown as Response)) as never

    const message = await plur.forget('ENG-GPL-2026-08-13-025', 'testing', { force: true }).then(
      () => 'retired', (e: Error) => e.message,
    )
    expect(message).toContain('Engram not found')
    expect(message, 'a reachable 404 must read as absence, not uncertainty')
      .not.toMatch(/could not be reached/)
  })
})
