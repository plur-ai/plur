/**
 * A LOCAL scope must never reach a remote store (#831/#855 follow-up).
 *
 * `forget()` validated `primary | local | global | project:*` as legitimate
 * targets and then guarded only `targetScope === 'primary'` before the remote
 * walk. The 2026-08-13 evaluator panel measured the result: three of the four
 * targets the error message itself advertises issued a remote DELETE when the
 * id was absent locally, and reported success.
 *
 *     scope="global"      threw=null  remote DELETEs=1
 *     scope="local"       threw=null  remote DELETEs=1
 *     scope="project:foo" threw=null  remote DELETEs=1
 *     scope="primary"     threw        remote DELETEs=0   (control)
 *
 * The caller said "the local one" and an unrelated remote engram was destroyed.
 * `feedback()` had no such guard at all — not even for `primary`.
 *
 * These tests are written against the OBSERVED EFFECT (did a DELETE leave the
 * process?) rather than against the return value, because "reported success
 * while doing the wrong thing" is precisely the failure being fixed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, isLocalOnlyScope } from '../src/index.js'

const LOCAL_SCOPES = ['primary', 'local', 'global', 'project:foo'] as const

describe('an explicit local scope never routes to a remote (#855)', () => {
  let dir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-localscope-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: 'https://plur.example.com/sse', token: 'tok', scope: 'group:test', shared: true, readonly: false }],
      index: false,
    }))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
    // A remote that HAS the engram and will happily delete it — so anything
    // reaching the network succeeds, and only the guard can stop it.
    fetchMock.mockImplementation((async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (typeof url === 'string' && url.includes('/engrams/ENG-REMOTE-ONLY')) {
        return {
          ok: true, status: 200,
          json: async () => (method === 'DELETE'
            ? { id: 'ENG-REMOTE-ONLY', status: 'retired' }
            : { id: 'ENG-REMOTE-ONLY', scope: 'group:test', status: 'active', data: { statement: 'remote fact' } }),
          text: async () => '',
        } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    }) as any)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const mutatingCalls = (method: string) =>
    fetchMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === method)

  it.each(LOCAL_SCOPES)('forget(scope: "%s") issues no remote DELETE', async scope => {
    const plur = new Plur({ path: dir })
    await expect(
      plur.forget('ENG-REMOTE-ONLY', 'wrong target', { scope, force: true }),
      `scope "${scope}" names a local target — the remote engram must be untouched`,
    ).rejects.toThrow(/not found in the local store/)
    expect(mutatingCalls('DELETE'), `scope "${scope}" reached the network`).toHaveLength(0)
  })

  it.each(LOCAL_SCOPES)('feedback(scope: "%s") issues no remote write', async scope => {
    const plur = new Plur({ path: dir })
    // `primary` already had its own refusal, earlier and with its own wording
    // (it also skips the secondary-store walk); the other three had none.
    await expect(
      plur.feedback('ENG-REMOTE-ONLY', 'positive', scope),
    ).rejects.toThrow(/not found in (the local|primary) store/)
    expect(mutatingCalls('POST'), `scope "${scope}" reached the network`).toHaveLength(0)
    expect(mutatingCalls('PATCH'), `scope "${scope}" reached the network`).toHaveLength(0)
  })

  it('still routes to the remote when the scope names the remote', async () => {
    // The control. The guard must not have closed the legitimate path.
    const plur = new Plur({ path: dir })
    await plur.forget('ENG-REMOTE-ONLY', 'genuinely remote', { scope: 'group:test' })
    expect(mutatingCalls('DELETE')).toHaveLength(1)
  })

  it('still searches everywhere when no scope is given', async () => {
    const plur = new Plur({ path: dir })
    await plur.forget('ENG-REMOTE-ONLY', 'unscoped')
    expect(mutatingCalls('DELETE')).toHaveLength(1)
  })

  it('the predicate is shared, so the two call sites cannot drift again', () => {
    // #855 asked for one helper when both landed. It was not built, the copies
    // diverged, and the divergence was the destructive bug. Asserting the
    // predicate directly is what makes a third caller inherit the rule.
    for (const s of LOCAL_SCOPES) expect(isLocalOnlyScope(s), s).toBe(true)
    for (const s of ['group:test', 'user:alice', 'group:plur/plur-ai/engineering']) {
      expect(isLocalOnlyScope(s), s).toBe(false)
    }
  })
})
