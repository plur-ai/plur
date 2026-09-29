/**
 * #1299: a queued write that can never succeed is not silent.
 *
 * Observed on a developer store: 14 queued writes, 10 of them refused with
 * `403 Cannot write to scope ...` on every attempt for 12 days (one at 103
 * attempts). Nothing said so unless you ran `plur outbox` and read the errors.
 *
 * Each outbox entry is classified from its last failure: `retrying` (network,
 * 5xx, 429, timeout — the next flush may succeed) or `needs_action` (401, 403,
 * 404, 422, an explicit write refusal, or no writable store for the scope —
 * retrying cannot fix it). Nothing is dropped or rescoped automatically; a
 * `needs_action` entry is only retried less often.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, classifyOutboxFailure, summarizeOutbox, NEEDS_ACTION_RETRY_MS } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'outbox-needs-action-token'
const SCOPE = 'group:example/eng'

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

describe('classifyOutboxFailure (#1299)', () => {
  it('classifies HTTP statuses retrying cannot fix as needs_action', () => {
    for (const status of [401, 403, 404, 422]) {
      expect(classifyOutboxFailure({ last_status: status }).state, String(status)).toBe('needs_action')
    }
  })

  it('classifies transient statuses as retrying', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyOutboxFailure({ last_status: status }).state, String(status)).toBe('retrying')
    }
  })

  it('classifies an old entry with no stored status from its error text', () => {
    expect(classifyOutboxFailure({
      last_error: 'Remote store append failed: 403 Cannot write to scope group:example/eng',
    }).state).toBe('needs_action')
    expect(classifyOutboxFailure({ last_error: 'Remote store append failed: 401 unauthorized' }).state).toBe('needs_action')
    expect(classifyOutboxFailure({ last_error: 'Cannot write to scope group:example/eng' }).state).toBe('needs_action')
    expect(classifyOutboxFailure({ last_error: 'fetch failed' }).state).toBe('retrying')
    expect(classifyOutboxFailure({ last_error: 'request to https://store.example timed out after 30000ms' }).state).toBe('retrying')
    expect(classifyOutboxFailure({ last_error: 'Remote store append failed: 503 down' }).state).toBe('retrying')
  })

  it('is conservative: unknown or missing errors are retrying', () => {
    expect(classifyOutboxFailure({}).state).toBe('retrying')
    expect(classifyOutboxFailure({ last_error: 'something odd happened' }).state).toBe('retrying')
    // A bare number in a message is not a status.
    expect(classifyOutboxFailure({ last_error: 'engram 403 was malformed' }).state).toBe('retrying')
  })

  it('no writable store for the scope is needs_action', () => {
    expect(classifyOutboxFailure({ has_store: false }).state).toBe('needs_action')
  })

  it('a needs_action verdict carries a one-line reason and a real next step', () => {
    const v = classifyOutboxFailure({ last_status: 403 })
    expect(v.reason).toMatch(/403/)
    expect(v.reason).not.toContain('\n')
    expect(v.next_step).toMatch(/plur rescope/)
  })
})

describe('outbox needs_action end to end (#1299)', () => {
  let dir: string

  beforeEach(() => {
    server.reset()
    dir = mkdtempSync(join(tmpdir(), 'plur-outbox-needs-action-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      embeddings: { enabled: false },
      stores: [{ url: baseUrl, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
    }))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function queue(plur: Plur, status: number, body: string, statement: string): Promise<string> {
    server.appendErrorResponse = { status, body }
    const e = await plur.learnRouted(statement, { scope: SCOPE, type: 'behavioral' })
    await waitFor(async () => (await plur.listOutbox()).some(x => x.id === e.id && x.attempt_count >= 1))
    server.appendErrorResponse = null
    server.appendCalls = 0
    return e.id
  }

  /** The persisted engram rows, minus the outbox's retry bookkeeping. */
  function rowsWithoutBookkeeping(): unknown[] {
    const raw = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as any
    const list = (Array.isArray(raw) ? raw : raw?.engrams ?? []) as any[]
    return list.map(e => {
      const copy = JSON.parse(JSON.stringify(e))
      const ob = copy.structured_data?._outbox
      if (ob) {
        delete ob.attempt_count
        delete ob.last_attempt
        delete ob.last_error
        delete ob.last_status
      }
      return copy
    })
  }

  it('a 403 refusal is recorded with its status and classified needs_action', async () => {
    const plur = new Plur({ path: dir })
    const id = await queue(plur, 403, `Cannot write to scope ${SCOPE}`, 'refused engram')
    const [entry] = await plur.listOutbox()
    expect(entry.id).toBe(id)
    expect(entry.last_status).toBe(403)
    expect(entry.state).toBe('needs_action')
    expect(entry.reason).toMatch(/403/)
    expect(entry.next_step).toMatch(/plur rescope/)
  })

  it('a network-style failure is classified retrying', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 503, 'down for the test', 'transient engram')
    const [entry] = await plur.listOutbox()
    expect(entry.state).toBe('retrying')
    expect(entry.reason).toBeUndefined()
  })

  it('status() and summarizeOutbox() count needs_action entries per scope', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 403, `Cannot write to scope ${SCOPE}`, 'refused engram one')
    await queue(plur, 403, `Cannot write to scope ${SCOPE}`, 'refused engram two')
    await queue(plur, 503, 'down', 'transient engram')

    const summary = summarizeOutbox(await plur.listOutbox())
    expect(summary).toMatchObject({ pending: 3, retrying: 1, needs_action: 2 })
    expect(summary.scopes).toHaveLength(1)
    expect(summary.scopes[0]).toMatchObject({ scope: SCOPE, count: 2 })
    expect(summary.scopes[0].reason).toMatch(/403/)
    expect(summary.scopes[0].next_step).toMatch(/plur rescope/)

    const status = await plur.status()
    expect(status.outbox_count).toBe(3)
    expect(status.outbox_needs_action).toBe(2)
    expect(status.outbox_attention?.[0]).toMatchObject({ scope: SCOPE, count: 2 })
  })

  it('an automatic flush backs off a needs_action entry; nothing is removed or rewritten', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 403, `Cannot write to scope ${SCOPE}`, 'refused engram')
    const rowsBefore = rowsWithoutBookkeeping()
    const [before] = await plur.listOutbox()

    // The store would now accept it — but an automatic flush inside the
    // back-off window does not dial the server for a needs_action entry.
    server.reset()
    const r = await plur.flushOutbox()
    expect(r).toMatchObject({ flushed: 0, failed: 0, held: 1 })
    expect(server.appendCalls).toBe(0)
    const [after] = await plur.listOutbox()
    expect(after).toEqual(before)
    expect(rowsWithoutBookkeeping()).toEqual(rowsBefore)
  })

  it('an explicit flush (force) retries it; only retry bookkeeping changes', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 403, `Cannot write to scope ${SCOPE}`, 'refused engram')
    const rowsBefore = rowsWithoutBookkeeping()
    const [before] = await plur.listOutbox()

    server.appendErrorResponse = { status: 403, body: `Cannot write to scope ${SCOPE}` }
    const r = await plur.flushOutbox({ force: true })
    expect(r).toMatchObject({ flushed: 0, failed: 1, held: 0 })
    expect(server.appendCalls).toBe(1)
    const [after] = await plur.listOutbox()
    expect(after.id).toBe(before.id)
    expect(after.attempt_count).toBe(before.attempt_count + 1)
    expect(after.state).toBe('needs_action')
    expect(rowsWithoutBookkeeping()).toEqual(rowsBefore)

    // Once the store accepts it, a forced flush delivers it as usual.
    server.appendErrorResponse = null
    const ok = await plur.flushOutbox({ force: true })
    expect(ok.flushed).toBe(1)
    expect(await plur.outboxCount()).toBe(0)
  })

  it('after the back-off window an automatic flush retries it again', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 403, `Cannot write to scope ${SCOPE}`, 'refused engram')
    // Age the last attempt past the window by editing the file directly.
    const file = join(dir, 'engrams.yaml')
    const old = new Date(Date.now() - NEEDS_ACTION_RETRY_MS - 60_000).toISOString()
    const text = readFileSync(file, 'utf8').replace(/last_attempt: .*/g, `last_attempt: '${old}'`)
    writeFileSync(file, text)

    const fresh = new Plur({ path: dir })
    const r = await fresh.flushOutbox()
    expect(r).toMatchObject({ flushed: 1, held: 0 })
    expect(server.appendCalls).toBe(1)
  })

  it('a retrying entry is retried on every flush, with no back-off', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 503, 'down', 'transient engram')
    server.appendErrorResponse = { status: 503, body: 'still down' }
    const r1 = await plur.flushOutbox()
    expect(r1).toMatchObject({ failed: 1, held: 0 })
    expect(server.appendCalls).toBe(1)
    const [entry] = await plur.listOutbox()
    expect(entry.state).toBe('retrying')
    expect(entry.last_status).toBe(503)
  })

  it('an entry whose scope has no writable store is needs_action', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 503, 'down', 'orphaned engram')
    // The store for that scope is removed from config after queueing.
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false } }))
    const [entry] = await new Plur({ path: dir }).listOutbox()
    expect(entry.state).toBe('needs_action')
    expect(entry.reason).toMatch(/no writable store/i)
  })
})
