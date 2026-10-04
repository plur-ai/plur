/**
 * Outbox lease (spec/formal/issues/outbox-lease.md; formal WritePath §1c,
 * decision D2): delivery is at-most-once ACROSS processes, not only within one.
 *
 * Before the lease, the in-flight claim (`_outboxInFlight`) was an in-memory
 * set: two processes flushing the same store (an MCP server and a CLI hook)
 * each selected the same queued row and each POSTed it, so the remote held the
 * engram twice. Theorem `guarded_at_most_once` held per process only.
 *
 * Two `Plur` instances on one directory stand in for two processes: they share
 * the store file and its lock, and nothing else — each has its own in-memory
 * claim set and its own lease holder id. The remote is the in-process HTTP stub
 * (real TCP, no fetch mocking) and counts every POST and DELETE. Interleavings
 * are forced by holding one POST open on the stub (`appendHook`) while the
 * other instance runs to completion. No real service is contacted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { PLUR_BOOKKEEPING_KEYS, userStructuredData } from '../src/content-fields.js'
import { StubServer } from './helpers/stub-server.js'
import { withAsyncLock, DEFAULT_ACQUIRE_TIMEOUT } from '../src/store/async-lock.js'
import { recordWriteOutcome } from '../src/remote-recall.js'

const TOKEN = 'lease-token'
const SCOPE = 'group:test'

async function waitFor(pred: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pred()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(r => setTimeout(r, 5))
  }
}

describe('outbox lease — two processes flushing one store', () => {
  let server: StubServer
  let url: string
  let dir: string

  beforeAll(async () => {
    server = new StubServer(TOKEN)
    ;({ url } = await server.start())
  })
  afterAll(async () => { await server.stop() })

  beforeEach(() => {
    server.appendHook = null
    server.appendErrorResponse = null
    server.appendCalls = 0
    server.deleteCalls = 0
    dir = mkdtempSync(join(tmpdir(), 'plur-outbox-lease-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const engramsFile = () => join(dir, 'engrams.yaml')
  const readRows = (): any[] => {
    if (!existsSync(engramsFile())) return []
    const doc = yaml.load(readFileSync(engramsFile(), 'utf8')) as { engrams?: any[] } | null
    return doc?.engrams ?? []
  }
  const rowOf = (id: string): any => readRows().find(e => e.id === id)
  /** Hand-edit one row, as another process (or an older client) would leave it. */
  const editRow = (id: string, f: (row: any) => void) => {
    const doc = yaml.load(readFileSync(engramsFile(), 'utf8')) as { engrams: any[] }
    const row = doc.engrams.find(e => e.id === id)
    f(row)
    writeFileSync(engramsFile(), yaml.dump(doc, { lineWidth: -1, noRefs: true }))
  }

  /** Hold the next POST on the wire until `release()`. */
  function holdNextAppend() {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let arrived = false
    server.appendHook = async () => {
      if (arrived) return
      arrived = true
      await gate
    }
    return { release, arrived: () => arrived }
  }

  /** Learn while the store rejects writes, so the engram sits queued (attempt_count 1). */
  async function queued(plur: Plur, statement: string) {
    server.appendErrorResponse = { status: 503, body: 'down' }
    const e = await plur.learn(statement, { scope: SCOPE, type: 'behavioral' })
    await waitFor(() => !!rowOf(e.id)?.structured_data?._outbox?.last_error, 'the background push to record its failure')
    await new Promise(r => setTimeout(r, 30))
    server.appendErrorResponse = null
    server.appendCalls = 0
    return e
  }

  it('two processes flushing concurrently push a queued row at most once', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e = await queued(a, 'a team fact two processes try to deliver')

    const hold = holdNextAppend()
    const flushingA = a.flushOutbox()
    await waitFor(hold.arrived, "A's POST to be on the wire")

    // B runs to completion while A's POST is held open.
    const rb = await b.flushOutbox()
    expect(rb.flushed, 'B pushed a row A holds a live lease on').toBe(0)

    hold.release()
    const ra = await flushingA
    expect(ra.flushed).toBe(1)
    expect(server.appendCalls, 'the remote received the same engram twice').toBe(1)
    expect(rowOf(e.id), 'the pushed row is handed off').toBeUndefined()
  })

  it("a flush in another process skips a row whose learn() push is in flight", async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const hold = holdNextAppend()
    const e = await a.learn('a team fact whose first push is slow', { scope: SCOPE, type: 'behavioral' })
    await waitFor(hold.arrived, "learn()'s background push to be on the wire")

    const rb = await b.flushOutbox()
    expect(rb.flushed).toBe(0)
    expect(server.appendCalls, "B re-POSTed a row A's learn() is delivering").toBe(1)

    hold.release()
    await waitFor(() => rowOf(e.id) === undefined, 'the local copy to be handed off')
    expect(server.appendCalls).toBe(1)
  })

  it('a row from an older client (no lease field) is unleased and delivered', async () => {
    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact queued by an older client')
    editRow(e.id, row => { delete row.structured_data._outboxLease })
    const r = await new Plur({ path: dir }).flushOutbox()
    expect(r.flushed).toBe(1)
    expect(server.appendCalls).toBe(1)
  })

  // ---- Audit of #1231 -------------------------------------------------------

  /** Shift `Date.now()` for this process by `off()` ms (clocks of all "processes" agree). */
  function shiftClock() {
    const real = Date.now
    let off = 0
    Date.now = () => real() + off
    return { add: (ms: number) => { off += ms }, restore: () => { Date.now = real } }
  }
  /** Take the store lock in-process and keep it until `release()`. */
  async function holdStoreLock() {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let inside!: () => void
    const entered = new Promise<void>(r => { inside = r })
    const held = withAsyncLock(engramsFile(), async () => { inside(); await gate })
    await entered
    return { release: async () => { release(); await held } }
  }

  it('finding 3: a flush that attempts nothing (breaker open) writes nothing and leases nothing', async () => {
    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact queued for a host whose breaker is open')
    for (let i = 0; i < 10; i++) recordWriteOutcome(url, false, Date.now(), a.remoteHealthStatePath())
    const before = readFileSync(engramsFile(), 'utf8')
    let writes = 0
    const orig = (a as any)._writeEngrams.bind(a)
    ;(a as any)._writeEngrams = async (...args: any[]) => { writes++; return orig(...args) }
    const origUpd = (a as any)._updateEngrams.bind(a)
    ;(a as any)._updateEngrams = async (...args: any[]) => { writes++; return origUpd(...args) }
    const r = await a.flushOutbox()
    expect(r.flushed).toBe(0)
    expect(r.expired_warnings.some(w => w.includes('circuit breaker open'))).toBe(true)
    expect(writes, 'the store was rewritten for a flush that attempted nothing').toBe(0)
    expect(readFileSync(engramsFile(), 'utf8')).toBe(before)
    expect(rowOf(e.id)?.structured_data?._outbox).toBeTruthy()
    expect(server.appendCalls).toBe(0)
  })

  // ---- Review of #1231 (2026-09-28) ------------------------------------------

  it("learn() keeps its in-flight claim until the failed push is recorded: a flush in the same instance does not POST the row", async () => {
    // The ordering the WritePath §1c text relies on: the claim is released only
    // AFTER the failure bookkeeping write. A flush in the same instance queued
    // on the store lock ahead of that write must find the row still claimed.
    const a = new Plur({ path: dir })
    let failFirst!: () => void
    const firstGate = new Promise<void>(r => { failFirst = r })
    let arrivals = 0
    server.appendHook = async (n: number) => {
      arrivals = n
      if (n === 1) { await firstGate; server.appendErrorResponse = { status: 503, body: 'down' }; return }
      server.appendErrorResponse = null
    }
    try {
      const e = await a.learn('a team fact whose failed push is still being recorded', { scope: SCOPE, type: 'behavioral' })
      await waitFor(() => arrivals === 1, "learn()'s POST to be on the wire")
      const lock = await holdStoreLock()
      const flushing = a.flushOutbox() // queued on the lock ahead of the failure bookkeeping
      await new Promise(r => setTimeout(r, 30))
      failFirst()
      await new Promise(r => setTimeout(r, 100)) // the failure reaches learn(), which waits for the lock
      await lock.release()
      const r = await flushing
      expect(r.flushed, 'the flush took a row whose failed push was not yet recorded').toBe(0)
      expect(server.appendCalls, 'the flush POSTed the row before the failure bookkeeping landed').toBe(1)
      await waitFor(() => rowOf(e.id)?.structured_data?._outbox?.attempt_count === 1, "the failed push's bookkeeping")
      expect(server.appendCalls).toBe(1)
    } finally { failFirst() }
  })

  it("listOutbox reports leased_until for a row being pushed now, this instance's own push included", async () => {
    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact listed while its push is on the wire')
    const hold = holdNextAppend()
    const flushing = a.flushOutbox()
    await waitFor(hold.arrived, 'the POST to be on the wire')
    const own = (await a.listOutbox()).find(x => x.id === e.id)
    const other = (await new Plur({ path: dir }).listOutbox()).find(x => x.id === e.id)
    expect(own?.leased_until).toBeTruthy()
    expect(other?.leased_until).toBe(own?.leased_until)
    hold.release()
    await flushing
  })
})

