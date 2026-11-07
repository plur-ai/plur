// security audit 2026-11-06: remote store bodies are byte-capped and a page may not carry more rows than asked for.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RemoteStore, _resetRemoteHostBreaker } from '../src/store/remote-store.js'

const MiB = 1024 * 1024

function row(i: number) {
  return { id: `ENG-2026-01-01-${String(i).padStart(7, '0')}`, scope: 'group:acme/eng', status: 'active',
    data: { statement: `dummy statement ${i}`, type: 'behavioral', domain: 'dummy' } }
}

/** A body that would stream `totalMiB` of JSON-ish bytes, counting what is actually pulled. */
function countingBody(prefix: string, totalMiB: number): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0
  let sent = 0
  const chunk = new TextEncoder().encode('x'.repeat(MiB))
  const head = new TextEncoder().encode(prefix)
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent === 0) { pulled += head.byteLength; ctrl.enqueue(head) }
      if (sent >= totalMiB) { ctrl.close(); return }
      sent++
      pulled += chunk.byteLength
      ctrl.enqueue(chunk)
    },
  })
  return { stream, pulled: () => pulled }
}

let originalFetch: typeof globalThis.fetch
let calls = 0

beforeEach(() => {
  originalFetch = globalThis.fetch
  calls = 0
  _resetRemoteHostBreaker()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stub(respond: (url: string) => Response): void {
  globalThis.fetch = (async (url: string) => { calls++; return respond(String(url)) }) as typeof fetch
}

const newStore = () => new RemoteStore('https://remote.invalid/sse', 'dummy-token', 'group:acme/eng')

describe('RemoteStore response bounds', () => {
  it('control: an ordinary 3-row page and /me body load', async () => {
    stub(url => url.endsWith('/me') ? Response.json({ scopes: ['group:acme/eng'] }) : Response.json({ rows: [row(1), row(2), row(3)], total_count: 3 }))
    expect(await newStore().load()).toHaveLength(3)
    expect((await newStore().me()).scopes).toEqual(['group:acme/eng'])
  })

  it('refuses a page carrying more rows than the requested limit, and does not cache it', async () => {
    stub(() => Response.json({ rows: Array.from({ length: 201 }, (_, i) => row(i)), total_count: 201 }))
    const s = newStore()
    expect(await s.load()).toHaveLength(0)
    const before = calls
    await s.load()
    expect(calls).toBeGreaterThan(before) // nothing was cached, the next load asks again
  })

  it('refuses an oversized page body without buffering it', async () => {
    const body = countingBody('{"rows":[],"pad":"', 64)
    stub(() => new Response(body.stream, { status: 200, headers: { 'content-type': 'application/json' } }))
    expect(await newStore().load()).toHaveLength(0)
    expect(body.pulled()).toBeLessThan(16 * MiB)
  })

  it('me() refuses an oversized body without buffering it', async () => {
    const body = countingBody('{"scopes":["group:acme/eng"],"pad":"', 64)
    stub(() => new Response(body.stream, { status: 200 }))
    await expect(newStore().me()).rejects.toThrow(/too large/i)
    expect(body.pulled()).toBeLessThan(16 * MiB)
  })
})
