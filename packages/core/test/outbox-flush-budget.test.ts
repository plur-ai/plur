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

  it('cuts a slow remote at the budget and leaves every entry queued, untouched', async () => {
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
    // A cut is our budget, not the remote's failure: attempt metadata is unchanged.
    const after = await plur.listOutbox()
    expect(after.map(e => [e.id, e.attempt_count, e.last_error]))
      .toEqual(before.map(e => [e.id, e.attempt_count, e.last_error]))
  })

  it('does not count a budget cut against the host: the next flush still dials it', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 1)

    server.appendDelayMs = 10_000
    for (let i = 0; i < 4; i++) await plur.flushOutbox({ timeoutMs: 100 })

    server.appendDelayMs = 0
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
