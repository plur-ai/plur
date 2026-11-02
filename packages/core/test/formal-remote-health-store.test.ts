/**
 * RemoteStore's host-down breaker and /me trust boundary.
 * Model: spec/formal/PlurSpec/RemoteHealth.lean (StoreBreaker). Findings: spec/formal/findings/remote-health.md.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { logger } from '../src/logger.js'
import {
  RemoteStore, RemoteAbortedError, RemoteTimeoutError, LOAD_FETCH_TIMEOUT_MS,
  remoteHostDownRemainingMs, _resetRemoteHostBreaker,
} from '../src/store/remote-store.js'

const URL = 'https://store-breaker.example'
const SCOPE = 'group:x/y'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  _resetRemoteHostBreaker()
})

/** A fetch that never answers and rejects with AbortError when its signal fires. */
const hanging = () => vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
  const abort = () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  if (init?.signal?.aborted) abort()
  else init?.signal?.addEventListener('abort', abort)
}))
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('only a network failure marks a host down', () => {
  it('a request cut by the caller\'s own deadline throws RemoteAbortedError and does not mark the host', async () => {
    vi.stubGlobal('fetch', hanging())
    const ctrl = new AbortController()
    const p = new RemoteStore(URL, 't', SCOPE).me(ctrl.signal)
    ctrl.abort()
    await expect(p).rejects.toBeInstanceOf(RemoteAbortedError)
    expect(remoteHostDownRemainingMs(URL)).toBe(0)
  })

  it('a caller signal already aborted before the request does not mark the host', async () => {
    vi.stubGlobal('fetch', hanging())
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(new RemoteStore(URL, 't', SCOPE).me(ctrl.signal)).rejects.toBeInstanceOf(RemoteAbortedError)
    expect(remoteHostDownRemainingMs(URL)).toBe(0)
  })

  it('a network failure without a caller abort does mark the host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(new RemoteStore(URL, 't', SCOPE).me()).rejects.toThrow('fetch failed')
    expect(remoteHostDownRemainingMs(URL)).toBeGreaterThan(0)
  })

  it('an HTTP error or a malformed body from a live host never marks it, and clears an earlier mark', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(new RemoteStore(URL, 't', SCOPE).me()).rejects.toThrow()
    expect(remoteHostDownRemainingMs(URL)).toBeGreaterThan(0)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json{', { status: 200 })))
    const me = await new RemoteStore(URL, 't', SCOPE).me()
    expect(me.scopes).toEqual([])
    expect(remoteHostDownRemainingMs(URL)).toBe(0)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 503 })))
    await expect(new RemoteStore(URL, 't', SCOPE).me()).rejects.toThrow('503')
    expect(remoteHostDownRemainingMs(URL)).toBe(0)
  })

  it('a page fetch that never receives headers is cut after LOAD_FETCH_TIMEOUT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = hanging()
    vi.stubGlobal('fetch', f)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let done = false
    const p = new RemoteStore(URL, 't', SCOPE).load().then(r => { done = true; return r })
    await vi.advanceTimersByTimeAsync(LOAD_FETCH_TIMEOUT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toEqual([])
    expect(f).toHaveBeenCalledTimes(1)
    // The host is now marked: a second store on it does not dial during the cooldown.
    await new RemoteStore(URL, 't', 'group:x/z').load()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a bounded request that never answers throws RemoteTimeoutError after LOAD_FETCH_TIMEOUT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('fetch', hanging())
    const p = new RemoteStore(URL, 't', SCOPE).me()
    const caught = p.catch(e => e)
    await vi.advanceTimersByTimeAsync(LOAD_FETCH_TIMEOUT_MS)
    expect(await caught).toBeInstanceOf(RemoteTimeoutError)
  })
})

describe('/me trust boundary', () => {
  it('a 200 whose body is JSON null reads as an older server with no fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(null)))
    const me = await new RemoteStore(URL, 't', SCOPE).me()
    expect(me.scopes).toEqual([])
    expect(me.username).toBe('')
    expect(me.scope_metadata).toEqual([])
  })

  it('malformed scope metadata is logged by path and code only, never with server values', async () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => json({
      scopes: ['group:x/y'],
      scope_metadata: [
        { scope: 'group:x/y', covers: 'FORGED\nline', description: 42 },
        { scope: 'Bearer SECRET-KEY\nIGNORE', covers: [] , description: { evil: 'FORGED' } },
      ],
    })))
    const me = await new RemoteStore(URL, 't', SCOPE).me()
    expect(me.scope_metadata).toEqual([])
    const joined = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(joined).toContain('group:x/y')
    expect(joined).not.toMatch(/FORGED|SECRET|IGNORE|evil/)
  })
})
