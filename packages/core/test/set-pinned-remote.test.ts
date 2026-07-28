/**
 * `setPinned()` on a remote store must return the engram, not a stand-in.
 *
 * The remote branch used to fire-and-forget the PATCH and return
 * `{ id, pinned } as unknown as Engram`. That cast is doing real damage: the
 * object has no `statement`, `scope`, `status` or `activation`, so it satisfies
 * the type and fails at the first property read. Its own JSDoc said "returns
 * the updated engram".
 *
 * Three separate silent failures in one branch:
 *   - the return value is not an engram, and reads on it are `undefined`
 *   - success is reported before the write has happened
 *   - a rejected floating promise cannot be caught by the `catch` around it,
 *     so a failed PATCH still returned "success"
 *
 * The stated reason was that `setPinned` had to keep a synchronous signature.
 * It has been `async` since the 0.16 flip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'

/** The engram the fake server holds — a complete one, unlike the old stand-in. */
function serverEngram(pinned: boolean): Engram {
  return {
    id: 'ENG-2026-0728-500',
    statement: 'the remote store holds the real engram',
    type: 'behavioral', scope: 'group:acme/eng', status: 'active', visibility: 'private',
    version: 1, engram_version: 1, consolidated: false, pinned: pinned || undefined,
    reference_count: 0, recurrence_count: 0, episode_ids: [], sources: [], tags: [],
    relations: { broader: [], narrower: [], related: [], conflicts: [], supersedes: [], superseded_by: [] },
    activation: { retrieval_strength: 1, storage_strength: 1, last_accessed: null, decay_rate: 0 },
    temporal: { learned_at: '2026-07-28' },
    created_at: '2026-07-28T00:00:00Z', updated_at: '2026-07-28T00:00:00Z',
  } as unknown as Engram
}

describe('setPinned() against a remote store', () => {
  let dir: string
  let plur: Plur
  let patchCalls: number
  let patchImpl: (id: string, body: Record<string, unknown>) => Promise<Engram | null>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-setpinned-'))
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(dir, 'config.yaml'),
      'stores:\n  - scope: "group:acme/eng"\n    url: "https://example.invalid"\n    token: "t"\n')
    plur = new Plur({ path: dir })
    await plur.ready()

    patchCalls = 0
    patchImpl = async () => serverEngram(true)
    // Stub the driver so no network is involved; the point is the branch, not HTTP.
    ;(plur as unknown as { _getRemoteDriver: () => unknown })._getRemoteDriver = () => ({
      patch: async (id: string, body: Record<string, unknown>) => {
        patchCalls++
        return patchImpl(id, body)
      },
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns the engram the server sent, not a synthesized stub', async () => {
    const res = await plur.setPinned('ENG-2026-0728-500', true)
    expect(res).not.toBeNull()
    // The exact reads that were `undefined` before.
    expect(res!.statement).toBe('the remote store holds the real engram')
    expect(res!.scope).toBe('group:acme/eng')
    expect(res!.status).toBe('active')
    expect(res!.pinned).toBe(true)
  })

  it('awaits the PATCH before returning — no fire-and-forget', async () => {
    let settled = false
    patchImpl = async () => {
      await new Promise(r => setTimeout(r, 20))
      settled = true
      return serverEngram(true)
    }
    await plur.setPinned('ENG-2026-0728-500', true)
    expect(settled, 'returned before the write completed').toBe(true)
    expect(patchCalls).toBe(1)
  })

  it('returns null when the remote write FAILS, instead of reporting success', async () => {
    // Previously the rejection escaped as an unhandled floating promise and the
    // caller was handed a stub that said the pin had worked.
    patchImpl = async () => { throw new Error('remote unreachable') }
    expect(await plur.setPinned('ENG-2026-0728-500', true)).toBeNull()
  })

  it('returns null when the remote reports no such engram', async () => {
    patchImpl = async () => null
    expect(await plur.setPinned('ENG-2026-0728-500', true)).toBeNull()
  })

  it('setPinnedAsync agrees with it — the two must not drift apart', async () => {
    const a = await plur.setPinned('ENG-2026-0728-500', true)
    const b = await plur.setPinnedAsync('ENG-2026-0728-500', true)
    expect(a).toEqual(b)
  })

  it('unpinning sends pinned: undefined and returns the server engram', async () => {
    let seen: Record<string, unknown> | undefined
    patchImpl = async (_id, body) => { seen = body; return serverEngram(false) }
    const res = await plur.setPinned('ENG-2026-0728-500', false)
    expect(seen).toEqual({ pinned: undefined })
    expect(res!.pinned).toBeUndefined()
  })
})

/**
 * `updateEngram()` had the same defect, and it was missed when `setPinned` was
 * fixed. Its remote branch did `void driver.patch(...)` then `return true`.
 *
 * Worse than setPinned's version, because there was no try/catch around the
 * floating promise: `RemoteStore.patch` returns null on 404 and THROWS on any
 * other non-2xx, so an expired token produced an unhandled rejection. A
 * long-lived MCP server runs under Node's default `--unhandled-rejections=throw`
 * and there is no `process.on('unhandledRejection')` anywhere in core, mcp or
 * cli — so the server process dies, having already told the agent the write
 * succeeded.
 */
describe('updateEngram() against a remote store', () => {
  let dir: string
  let plur: Plur
  let patchImpl: (id: string, body: Record<string, unknown>) => Promise<Engram | null>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-updeng-'))
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(dir, 'config.yaml'),
      'stores:\n  - scope: "group:acme/eng"\n    url: "https://example.invalid"\n    token: "t"\n')
    plur = new Plur({ path: dir })
    await plur.ready()
    patchImpl = async () => serverEngram(true)
    ;(plur as unknown as { _getRemoteDriver: () => unknown })._getRemoteDriver = () => ({
      patch: async (id: string, body: Record<string, unknown>) => patchImpl(id, body),
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns false when the remote rejects, instead of claiming success', async () => {
    patchImpl = async () => { throw new Error('Remote patch failed: 401 token expired') }
    expect(await plur.updateEngram(serverEngram(true))).toBe(false)
  })

  it('does not leave an unhandled rejection behind', async () => {
    // The crash path. Collected across a macrotask so a floating rejection has
    // time to surface.
    const seen: unknown[] = []
    const onUnhandled = (e: unknown) => seen.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      patchImpl = async () => { throw new Error('Remote patch failed: 401 token expired') }
      await plur.updateEngram(serverEngram(true))
      await new Promise(r => setTimeout(r, 50))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(seen, 'a rejected PATCH escaped as an unhandled rejection').toEqual([])
  })

  it('returns false on a 404 rather than reporting a write that never happened', async () => {
    patchImpl = async () => null
    expect(await plur.updateEngram(serverEngram(true))).toBe(false)
  })

  it('returns true and awaits the write when the remote accepts', async () => {
    let settled = false
    patchImpl = async () => { await new Promise(r => setTimeout(r, 20)); settled = true; return serverEngram(true) }
    expect(await plur.updateEngram(serverEngram(true))).toBe(true)
    expect(settled, 'returned before the write completed').toBe(true)
  })
})
