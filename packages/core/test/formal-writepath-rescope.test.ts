/**
 * Formal-verification replay (spec/formal/PlurSpec/WritePath.lean, candidate 6):
 * rescope() "atomic semantics" on the remote route (#676).
 *
 * The documented contract is per-engram: either the move lands (copy pushed,
 * source retired unless keep_local) or it fails loud with the source untouched.
 * Two interleavings broke the reporting of that contract:
 *   - the push LANDED and retiring the local source then threw: the exception
 *     escaped the whole batch — later ids never ran, and nothing told the caller
 *     that a copy now exists at the target (a retry pushes it again);
 *   - the source VANISHED while the push was in flight: nothing was retired, yet
 *     an `engram_retired` history event was appended for it.
 * Interleavings are driven through the fetch seam (the fake remote acts inside
 * its POST handler); nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, readHistory } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const TEAM = 'group:acme/team'

describe('formal WritePath — rescope remote route reports what happened (candidate 6)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let onPost: (n: number) => Promise<void>
  let posts: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-rescope-'))
    originalFetch = globalThis.fetch
    posts = 0
    onPost = async () => {}
    globalThis.fetch = vi.fn(async (_url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts++
        await onPost(posts)
        return { ok: true, status: 201, json: async () => ({ id: `SRV-${posts}` }), text: async () => '' } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as unknown as Response
    }) as never
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: TEAM, shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => {
    try { chmodSync(dir, 0o755) } catch { /* already restored */ }
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  it('a push that lands but whose local retire fails is reported per id, and the batch continues', async () => {
    const plur = new Plur({ path: dir })
    const a = await plur.learn('first fact that belongs to the team', { scope: 'global', type: 'behavioral' })
    const b = await plur.learn('second fact that belongs to the team', { scope: 'global', type: 'behavioral' })
    // First POST: the store directory becomes unwritable, so retiring `a` fails.
    // Second POST: writable again, so `b` completes normally.
    onPost = async (n) => { chmodSync(dir, n === 1 ? 0o555 : 0o755) }

    let out: Awaited<ReturnType<Plur['rescope']>> | undefined
    let thrown: unknown
    try { out = await plur.rescope([a.id, b.id], TEAM) } catch (err) { thrown = err }
    chmodSync(dir, 0o755)

    expect(thrown, `rescope threw instead of reporting per id: ${String(thrown)}`).toBeUndefined()
    expect(posts, 'the batch stopped after the first id').toBe(2)
    const [ra, rb] = out!.results
    expect(ra.status).toBe('error')
    expect(ra.new_id, 'the copy that landed on the remote went unreported').toBe('SRV-1')
    expect(ra.error).toMatch(/SRV-1/)
    expect(rb.status).toBe('rescoped')
    expect(out!.success).toBe(false)
    expect((await plur.getById(b.id))!.status).toBe('retired')
  })

  it('a source that vanished during the push gets no engram_retired history event', async () => {
    const plur = new Plur({ path: dir })
    const other = new Plur({ path: dir })
    const e = await plur.learn('a fact removed by another process mid-move', { scope: 'global', type: 'behavioral' })
    onPost = async () => {
      await other.forget(e.id, 'removed elsewhere', { force: true })
      await other.compact()
    }

    const { results } = await plur.rescope(e.id, TEAM)
    expect(results[0].new_id).toBe('SRV-1')

    const month = new Date().toISOString().slice(0, 7)
    const rescopeRetired = readHistory(dir, month).filter(ev =>
      ev.event === 'engram_retired' && ev.engram_id === e.id
      && (ev.data as { routed_to?: string } | undefined)?.routed_to === 'rescope')
    expect(rescopeRetired, 'history records a rescope retirement that never happened').toEqual([])
  })

  it('good case: a plain remote rescope pushes once and retires the source', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('a fact moved cleanly', { scope: 'global', type: 'behavioral' })
    const { results, success } = await plur.rescope(e.id, TEAM)
    expect(success).toBe(true)
    expect(results[0]).toMatchObject({ status: 'rescoped', new_id: 'SRV-1' })
    expect((await plur.getById(e.id))!.status).toBe('retired')
  })
})
