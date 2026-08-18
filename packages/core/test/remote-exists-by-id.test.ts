/**
 * `RemoteStore.existsById` — the ambiguity probe, and why it must be bounded.
 *
 * This method exists because `getById` collapses "definitely absent" and
 * "cannot tell" onto the same `null`. `forget()` and `feedback()` need the
 * distinction: treating an unreachable store as "not there" is how an id
 * collision goes unnoticed and the wrong engram gets retired (#831).
 *
 * It shipped with NO test of its own, including when this branch added the
 * timeout. That mattered because both callers run it INSIDE the primary store
 * lock, one probe per configured remote. Unbounded, it inherits undici's 300s
 * `headersTimeout`, which exceeds the 180s `DEFAULT_ACQUIRE_TIMEOUT` — so a
 * host that completes its handshake and then stalls makes every waiting
 * `plur_learn` throw "Failed to acquire lock" and the engram is silently never
 * stored. A hang here is not slow, it is lost writes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { RemoteStore } from '../src/store/remote-store.js'

const URL = 'https://plur.example.com/sse'

function store(): RemoteStore {
  return new RemoteStore(URL, 'tok', 'group:acme/team')
}

/** A `Response`, typed so `typecheck:tests` does not infer implicit-any (TS7023). */
const res = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async (): Promise<unknown> => body,
  text: async (): Promise<string> => '',
} as unknown as Response)

describe('RemoteStore.existsById', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers() })

  it('returns false ONLY on an authoritative 404', async () => {
    globalThis.fetch = vi.fn(async () => res(404, null)) as never
    await expect(store().existsById('ENG-X-001')).resolves.toBe(false)
  })

  it('returns true when the body describes that engram', async () => {
    globalThis.fetch = vi.fn(async () => res(200, { id: 'ENG-X-001' })) as never
    await expect(store().existsById('ENG-X-001')).resolves.toBe(true)
  })

  it('a bare 200 is not proof — the body must name the engram', async () => {
    // Servers and proxies answer 200 with a collection or envelope payload on
    // routes they do not recognise. Inferring existence from the status line
    // alone turns that into a false collision report on every forget.
    globalThis.fetch = vi.fn(async () => res(200, { rows: [], total_count: 0 })) as never
    await expect(store().existsById('ENG-X-001')).resolves.toBe(false)
  })

  it('THROWS on a transport failure rather than reporting absence', async () => {
    // The whole reason this method exists. Returning false here would make an
    // unreachable store indistinguishable from an empty one.
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as never
    await expect(store().existsById('ENG-X-001')).rejects.toThrow(/failed against/)
  })

  it('THROWS on 5xx and on auth rejection', async () => {
    for (const status of [500, 502, 401, 403]) {
      globalThis.fetch = vi.fn(async () => res(status, null)) as never
      await expect(store().existsById('ENG-X-001'), `HTTP ${status} was treated as absent`)
        .rejects.toThrow()
    }
  })

  it('is BOUNDED — a stalled host aborts instead of hanging the store lock', async () => {
    // The fix this branch added. Both callers hold the primary store lock
    // across this call, so an unbounded fetch does not merely delay the
    // probe — it exhausts every other writer's lock-acquire budget.
    vi.useFakeTimers()
    let abortReason: unknown
    globalThis.fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          abortReason = (init.signal as AbortSignal & { reason?: unknown }).reason
          reject(new Error('aborted'))
        })
      })) as never

    // The settle handler is attached BEFORE the clock is advanced. Attaching it
    // afterwards leaks an unhandled rejection: the abort fires during the
    // advance, so the promise is already rejected by the time `expect().rejects`
    // subscribes, and vitest reports a stray error alongside a passing test.
    const settled = store().existsById('ENG-X-001').then(
      () => 'resolved',
      (e: Error) => e.message,
    )
    await vi.advanceTimersByTimeAsync(31_000)

    expect(await settled, 'the probe never aborted — it would hold the lock indefinitely')
      .toMatch(/timed out after \d+ms/)
    expect(abortReason, 'the request was not actually aborted, only reported as timed out')
      .toBeDefined()
  })

  it('reports a timeout as "cannot tell", never as absence', async () => {
    // A timed-out probe must not be swallowed into `false` by a caller reading
    // only the resolved value — so the rejection is the contract, and its
    // message distinguishes a timeout from any other transport failure.
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as never

    const pending = store().existsById('ENG-X-001').then(
      v => ({ resolved: v as boolean | undefined, message: undefined as string | undefined }),
      (e: Error) => ({ resolved: undefined, message: e.message }),
    )
    await vi.advanceTimersByTimeAsync(31_000)
    const outcome = await pending

    expect(outcome.resolved, 'a timeout resolved to a value — callers cannot tell it apart from a 404')
      .toBeUndefined()
    expect(outcome.message).toMatch(/timed out/)
    expect(outcome.message).not.toMatch(/^existence probe for ENG-X-001 failed/)
  })
})

/**
 * Every endpoint is bounded, not just the two that were noticed individually.
 *
 * `load()` was bounded by #504 and `existsById` by the 2026-08-13 audit. The
 * other six — `/me`, `append`, `getById`, `remove`, `feedback`, `patch` — were
 * bare `fetch`, inheriting undici's 300s `headersTimeout`. `forget()` and
 * `feedback()` walk every configured store calling `getById`, and several of
 * those paths hold the primary store lock while they do it.
 *
 * Reproduced before the fix: one `feedback()` against a store with an
 * unreachable host did not return in 120 seconds.
 */
describe('every RemoteStore request is bounded', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers() })

  /** Never settles unless aborted — stands in for a host that stalls after the handshake. */
  const stalling = () => vi.fn((_u: string, init?: { signal?: AbortSignal }) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
    })) as never

  it.each([
    ['getById', (s: RemoteStore) => s.getById('ENG-X-001')],
    ['remove', (s: RemoteStore) => s.remove('ENG-X-001')],
    ['append', (s: RemoteStore) => s.append({ id: 'ENG-X-001', statement: 'x' } as never)],
    ['feedback', (s: RemoteStore) => s.feedback('ENG-X-001', 'positive')],
  ])('%s settles rather than hanging when the host stalls', async (_name, call) => {
    vi.useFakeTimers()
    globalThis.fetch = stalling()

    // Settle handler attached BEFORE advancing, or the rejection lands
    // unhandled — see the note in the timeout test above.
    const settled = call(store()).then(() => 'settled', () => 'settled')
    await vi.advanceTimersByTimeAsync(31_000)

    await expect(settled, 'the call never returned — it would hold the store lock').resolves.toBe('settled')
  })

  it('the bound is one shared helper, so a new endpoint inherits it', () => {
    // The reason this is a helper and not six call-site fixes: a rule enforced
    // by convention at N sites holds at N-1 of them. Asserted against the
    // source so a seventh bare `fetch` fails here rather than in production.
    const src = readFileSync(join(__dirname, '..', 'src', 'store', 'remote-store.ts'), 'utf8')
    const bare = [...src.matchAll(/await fetch\(/g)]
    // Exactly two remain by design: `fetchBounded` itself, and the two paths
    // that build their own AbortController (`load`'s pager, `existsById`).
    expect(bare.length, 'a bare fetch was added without a timeout').toBeLessThanOrEqual(3)
  })
})
