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
import { createServer, type Server } from 'http'
import { once } from 'events'
import type { AddressInfo } from 'net'
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

  it('unpinning sends an explicit false, and it survives JSON (#1149)', async () => {
    // Was `expect(seen).toEqual({ pinned: undefined })` — an assertion that was
    // true of the object and false of the request. `JSON.stringify` drops an
    // undefined property, so the PATCH serialized to `{}`, the server applied
    // nothing, and the still-pinned row came back reported as a successful
    // unpin. `patch()`'s own optimistic-merge branch already says as much:
    // "only defined update values are applied, mirroring what JSON.stringify
    // actually sent to the server".
    let seen: Record<string, unknown> | undefined
    patchImpl = async (_id, body) => { seen = body; return serverEngram(false) }
    const res = await plur.setPinned('ENG-2026-0728-500', false)
    expect(seen).toEqual({ pinned: false })
    // The assertion the old one could not make: it is still there after a round
    // trip through the serializer the driver actually uses.
    expect(JSON.parse(JSON.stringify(seen))).toEqual({ pinned: false })
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

/**
 * A refused DELETE must not be reported as a missing engram.
 *
 * `forget()`'s remote branch looked the engram up, called `remove()`, and if
 * that returned false simply carried on — falling through to
 * `Engram not found: <id>`. So a user whose token lacks delete rights for the
 * scope is told the engram does not exist. They stop looking; it is still
 * there. The two outcomes need different words because they need different
 * actions.
 */
describe('forget() when the remote refuses the delete', () => {
  let dir: string
  let plur: Plur
  let removeResult: boolean

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-forget-refuse-'))
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(dir, 'config.yaml'),
      'stores:\n  - scope: "group:acme/eng"\n    url: "https://example.invalid"\n    token: "t"\n')
    plur = new Plur({ path: dir })
    await plur.ready()
    removeResult = false
    ;(plur as unknown as { _getRemoteDriver: () => unknown })._getRemoteDriver = () => ({
      getById: async () => serverEngram(false),   // the engram DOES exist there
      remove: async () => removeResult,
      patch: async () => serverEngram(false),
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('says the server refused, not that the engram is missing', async () => {
    await expect(plur.forget('ENG-2026-0728-500', 'obsolete')).rejects.toThrow(/refused to retire/)
  })

  it('names the scope and says it was NOT removed', async () => {
    await expect(plur.forget('ENG-2026-0728-500', 'obsolete')).rejects.toThrow(/group:acme\/eng/)
    await expect(plur.forget('ENG-2026-0728-500', 'obsolete')).rejects.toThrow(/NOT removed/)
  })

  it('a genuinely missing engram still reports "not found"', async () => {
    // The distinction only means something if the other branch still says the
    // other thing.
    ;(plur as unknown as { _getRemoteDriver: () => unknown })._getRemoteDriver = () => ({
      getById: async () => null,
      remove: async () => false,
      patch: async () => null,
    })
    await expect(plur.forget('ENG-2026-0728-500', 'obsolete')).rejects.toThrow(/Engram not found/)
  })

  it('a successful remote retire still succeeds', async () => {
    removeResult = true
    await expect(plur.forget('ENG-2026-0728-500', 'obsolete')).resolves.toBeUndefined()
  })
})

/**
 * The same unpin, over a real socket through the real serializer (#1149).
 *
 * The suite above stubs `_getRemoteDriver`, so the body it inspects is a
 * JavaScript object that never meets `JSON.stringify`. That is precisely the
 * blind spot that let `{ pinned: undefined }` stand as an unpin for a release:
 * the assertion was true of the object and false of the request, and no test
 * looked at the request.
 *
 * These take the body off the wire and read the row back from the server, so a
 * fix has to change what the server stores, not only what the caller passes.
 */
describe('setPinned() unpin over HTTP (#1149)', () => {
  const ID = 'ENG-2026-0728-500'
  const SCOPE = 'group:acme/eng'

  let dir: string
  let server: Server
  let seen: Array<{ method: string; body: unknown }>
  let stored: Record<string, unknown>
  let plur: Plur

  beforeEach(async () => {
    seen = []
    stored = { ...(serverEngram(true) as unknown as Record<string, unknown>) }

    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
      seen.push({ method: req.method!, body })
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'PATCH') {
        // Ordinary partial-update semantics: apply exactly what arrived.
        Object.assign(stored, body)
      }
      res.end(JSON.stringify({ engram: { id: ID, scope: SCOPE, status: 'active', data: stored } }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    dir = mkdtempSync(join(tmpdir(), 'plur-setpinned-http-'))
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(dir, 'config.yaml'),
      `stores:\n  - scope: "${SCOPE}"\n    url: "${url}"\n    token: "t"\n`)
    plur = new Plur({ path: dir })
    await plur.ready()
  })

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    server.closeAllConnections()
    await new Promise<void>(r => server.close(() => r()))
  })

  const patchBody = () => seen.find(s => s.method === 'PATCH')?.body

  it('transmits pinned: false and leaves the server row unpinned', async () => {
    await plur.setPinned(ID, false)
    // The body was `{}` before: an unpin that asked the server for nothing.
    expect(patchBody()).toEqual({ pinned: false })
    expect(stored.pinned).toBe(false)
  })

  it('setPinnedAsync unpins over the wire too — the two must not drift', async () => {
    await plur.setPinnedAsync(ID, false)
    expect(patchBody()).toEqual({ pinned: false })
    expect(stored.pinned).toBe(false)
  })

  it('still transmits pinned: true when pinning', async () => {
    // The control. Without it, "send the field unconditionally" and "send the
    // right value" are indistinguishable.
    stored.pinned = undefined
    await plur.setPinned(ID, true)
    expect(patchBody()).toEqual({ pinned: true })
    expect(stored.pinned).toBe(true)
  })
})
