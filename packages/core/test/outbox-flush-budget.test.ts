/**
 * #1269: a flush can be given a time budget.
 *
 * Editor hooks (session end, stop) run under a harness timeout of a few
 * seconds. A remote that is alive but slow holds each POST for up to the
 * 30s request bound, so an unbudgeted flush from a hook is killed by the
 * harness mid-flight. `flushOutbox({ timeoutMs })` stops at the budget:
 * the in-flight request is cut, nothing further is started, and every
 * entry not delivered stays queued exactly as it was.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'outbox-budget-token'
const SCOPE = 'group:test'

let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!(await pred())) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('flushOutbox({ timeoutMs }) (#1269)', () => {
  let dir: string

  beforeEach(() => {
    server.reset()
    dir = mkdtempSync(join(tmpdir(), 'plur-outbox-budget-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [{ url: baseUrl, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
    }))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** Queue `n` writes by making the remote refuse them at learn time. */
  async function queue(plur: Plur, n: number): Promise<void> {
    server.appendErrorResponse = { status: 503, body: 'down for the test' }
    for (let i = 0; i < n; i++) {
      await plur.learnRouted(`budgeted flush engram ${i}`, { scope: SCOPE, type: 'behavioral' })
    }
    await waitFor(async () => (await plur.listOutbox()).every(e => e.attempt_count >= 1) && (await plur.outboxCount()) === n)
    server.appendErrorResponse = null
  }

  it('cuts a slow remote at the budget and leaves every entry queued', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 2)
    const before = await plur.listOutbox()

    server.appendDelayMs = 10_000
    const t0 = Date.now()
    const result = await plur.flushOutbox({ timeoutMs: 300 })
    const elapsed = Date.now() - t0

    expect(elapsed).toBeLessThan(2_000)
    expect(result.flushed).toBe(0)
    expect(result.deferred).toBe(2)
    expect(await plur.outboxCount()).toBe(2)
    const after = await plur.listOutbox()
    // The push that was IN FLIGHT when the budget ran out is recorded as an
    // attempt, so `plur outbox` shows it (review of #1277)…
    const cut = after.find(e => e.attempt_count === before.find(b => b.id === e.id)!.attempt_count + 1)
    expect(cut?.last_error).toMatch(/budget/)
    // …and the one never started is untouched.
    expect(after.filter(e => e.attempt_count === before.find(b => b.id === e.id)!.attempt_count)).toHaveLength(1)
  })

  it('a push cut mid-flight is not delivered twice when the server had already stored it', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 1)

    // Slow server: it stores the engram on receipt, answers after 10s. The
    // flush gives up at 300ms, so the client does not know it was delivered.
    server.appendDelayMs = 10_000
    await plur.flushOutbox({ timeoutMs: 300 })
    expect(server.engramCount).toBe(1)

    // Next flush, server healthy: it must find the copy, not post a second.
    server.appendDelayMs = 0
    for (let i = 0; i < 3; i++) await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(server.engramCount).toBe(1)
    expect(await plur.outboxCount()).toBe(0)
  })

  it('a push cut before the server stored it is still delivered on the next flush', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 1)

    server.appendDelayMs = 10_000
    server.appendDropWhileDelayed = true // cut before the server stores anything
    await plur.flushOutbox({ timeoutMs: 300 })
    expect(server.engramCount).toBe(0)

    server.appendDelayMs = 0
    server.appendDropWhileDelayed = false
    const result = await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(result.flushed).toBe(1)
    expect(server.engramCount).toBe(1)
    expect(await plur.outboxCount()).toBe(0)
  })

  it('sends a stable idempotency key: the local engram id', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 1)
    const [entry] = await plur.listOutbox()
    await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(server.lastAppendIdempotencyKey).toBe(entry.id)
  })

  it('the budget starts after the local store load, not before', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 1)

    // A large store: loading it takes longer than the whole network budget.
    const store = (plur as any)._primaryStore
    const realLoad = store.load.bind(store)
    store.load = async () => { await new Promise(r => setTimeout(r, 400)); return realLoad() }

    const result = await plur.flushOutbox({ timeoutMs: 200 })
    expect(result).toMatchObject({ flushed: 1, deferred: 0 })
    expect(await plur.outboxCount()).toBe(0)
  })

  it('does not count a budget cut against the host: the next flush still dials it', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 1)

    server.appendDelayMs = 10_000
    server.appendDropWhileDelayed = true // nothing lands, so every flush re-posts and is cut
    for (let i = 0; i < 4; i++) await plur.flushOutbox({ timeoutMs: 100 })

    server.appendDelayMs = 0
    server.appendDropWhileDelayed = false
    const result = await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(result.flushed).toBe(1)
    expect(await plur.outboxCount()).toBe(0)
  })

  it('a budget that is not reached changes nothing: success drains the outbox', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 2)

    const result = await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(result).toMatchObject({ flushed: 2, failed: 0, deferred: 0 })
    expect(await plur.outboxCount()).toBe(0)
  })

  it('a remote that refuses leaves entries queued with the failure recorded', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 1)

    server.appendErrorResponse = { status: 500, body: 'still broken' }
    const result = await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(result).toMatchObject({ flushed: 0, failed: 1, deferred: 0 })
    const [entry] = await plur.listOutbox()
    expect(entry.attempt_count).toBe(2)
    expect(entry.last_error).toContain('500')
  })
})
