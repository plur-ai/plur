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
 *
 * Decision C3 (owner, 2026-09-29; spec/formal/findings/outbox.md): #1277's
 * per-entry claims are the ONE duplicate-push guard. Row leases are no longer
 * taken or waited for on the push path; a lease an older client left on a row
 * holds nothing back, and `leased_until` in the outbox listing is advisory
 * (it reports the live claim). The tests below pin that.
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
import {
  leaseFree, canStartPush, dropLease, makeLease, newLeaseHolder, assertLeaseMarginFits, OUTBOX_LEASE_TTL_MS, OUTBOX_LEASE_MARGIN_MS,
} from '../src/outbox-lease.js'

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

  /** The per-entry claim file (#1277) a writer holds while it pushes `id`. */
  const claimOf = (plur: Plur, id: string) => join(plur.outboxClaimsDir(), `${id}.json`)

  /** Learn while the store rejects writes, so the engram sits queued (attempt_count 1). */
  async function queued(plur: Plur, statement: string) {
    server.appendErrorResponse = { status: 503, body: 'down' }
    const e = await plur.learn(statement, { scope: SCOPE, type: 'behavioral' })
    await waitFor(() => !!rowOf(e.id)?.structured_data?._outbox?.last_error, 'the background push to record its failure')
    // Decision C3: the flush no longer waits on the store lock before
    // selecting, so wait for the failed push to let go of its claim too.
    await waitFor(() => !existsSync(claimOf(plur, e.id)), 'the failed push to release its claim')
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
    // Decision C3: learn() holds the per-entry claim, not a row lease.
    expect(rowOf(e.id)?.structured_data?._outboxLease, 'learn() still stamps a row lease').toBeUndefined()
    expect(existsSync(claimOf(a, e.id)), "learn()'s push holds the entry's claim").toBe(true)

    const rb = await b.flushOutbox()
    expect(rb.flushed).toBe(0)
    expect(server.appendCalls, "B re-POSTed a row A's learn() is delivering").toBe(1)

    hold.release()
    await waitFor(() => rowOf(e.id) === undefined, 'the local copy to be handed off')
    expect(server.appendCalls).toBe(1)
  })

  it('an expired lease is taken over', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e = await queued(a, 'a team fact whose holder vanished long ago')
    editRow(e.id, row => {
      row.structured_data._outboxLease = { holder: 'crashed-process', expires_at: new Date(Date.now() - 1000).toISOString() }
    })
    const rb = await b.flushOutbox()
    expect(rb.flushed).toBe(1)
    expect(server.appendCalls).toBe(1)
    expect(rowOf(e.id)).toBeUndefined()
  })

  it('decision C3: a live row lease (an older client, a crashed holder) no longer holds delivery back', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e = await queued(a, 'a team fact whose holder crashed mid-flush')
    const expires = new Date(Date.now() + 400).toISOString()
    editRow(e.id, row => { row.structured_data._outboxLease = { holder: 'crashed-process', expires_at: expires } })

    // No claim is held on the entry, so it is delivered at once, exactly once.
    const first = await b.flushOutbox()
    expect(first.flushed, 'a row lease still held the push back').toBe(1)
    expect(server.appendCalls).toBe(1)
    expect(rowOf(e.id)).toBeUndefined()
  })

  it('the lease is cleared on merge-back after a failed push, so the next flush anywhere may retry', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e = await queued(a, 'a team fact whose flush fails')
    expect(rowOf(e.id)?.structured_data?._outboxLease, "learn()'s failure path clears its lease").toBeUndefined()

    server.appendErrorResponse = { status: 503, body: 'still down' }
    const ra = await a.flushOutbox()
    expect(ra.failed).toBe(1)
    const row = rowOf(e.id)
    expect(row.structured_data._outboxLease).toBeUndefined()
    expect(row.structured_data._outbox.attempt_count).toBe(2)

    server.appendErrorResponse = null
    server.appendCalls = 0
    const rb = await b.flushOutbox()
    expect(rb.flushed).toBe(1)
    expect(server.appendCalls).toBe(1)
  })

  it('decision C3: a retire-on-remote entry under a live row lease is retired at once (the DELETE is idempotent)', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e = await queued(a, 'a team fact forgotten while its push was on the wire')
    const expires = new Date(Date.now() + 400).toISOString()
    editRow(e.id, row => {
      row.status = 'retired'
      delete row.structured_data._outbox
      row.structured_data._retireRemote = {
        target_url: url, target_scope: SCOPE, server_id: 'ENG-SRV-999',
        queued_at: new Date().toISOString(), last_attempt: '', attempt_count: 0, last_error: '',
      }
      row.structured_data._outboxLease = { holder: 'other-process', expires_at: expires }
    })

    const first = await b.flushOutbox()
    expect(first.flushed, 'a row lease still held the retirement back').toBe(1)
    expect(server.deleteCalls).toBe(1)
    expect(rowOf(e.id)?.structured_data?._retireRemote).toBeUndefined()
    const second = await b.flushOutbox()
    expect(second.flushed).toBe(0)
    expect(server.deleteCalls, 'a done retirement was sent again').toBe(1)
  })

  it('the lease is bookkeeping, never content, and an update cannot forge one', async () => {
    expect(PLUR_BOOKKEEPING_KEYS.has('_outboxLease')).toBe(true)
    expect(userStructuredData({ _outboxLease: { holder: 'x', expires_at: '2099-01-01T00:00:00.000Z' } })).toBeUndefined()

    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact someone tries to park')
    const stored = (await a.getById(e.id))!
    await a.updateEngram({
      ...stored,
      structured_data: {
        ...((stored as any).structured_data ?? {}),
        // Audit of #1231: a forged lease inside TTL + margin — one that WOULD
        // block the flush if it were persisted. A 2099 lease is ignored by the
        // far-future clause anyway, so the assertion below passed vacuously.
        _outboxLease: { holder: 'forged', expires_at: new Date(Date.now() + 9 * 60_000).toISOString() },
      },
    } as any)
    expect(rowOf(e.id)?.structured_data?._outboxLease, 'a caller-set lease was persisted').toBeUndefined()
    const r = await new Plur({ path: dir }).flushOutbox()
    expect(r.flushed).toBe(1)
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

  it('decision C3: a flush posts without first waiting for the store lock', async () => {
    // Before C3 the flush selected and leased under the store lock, so a hook
    // flush behind a long lock holder never got its POST out (the abandoned-
    // hook case). Now only the merge-back takes the lock.
    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact flushed while another process holds the store lock')
    const lock = await holdStoreLock()
    let ra: Awaited<ReturnType<Plur['flushOutbox']>> | undefined
    try {
      const flushingA = a.flushOutbox().then(r => { ra = r; return r })
      await waitFor(() => server.appendCalls === 1, 'the POST to go out while the store lock is held')
      expect(ra, 'the flush finished its merge-back while the lock was held').toBeUndefined()
      await lock.release()
      await flushingA
    } finally { await lock.release() }
    expect(ra?.flushed).toBe(1)
    expect(server.appendCalls).toBe(1)
    expect(rowOf(e.id)).toBeUndefined()
  })

  it('finding 2 (decision C3): a merge-back that waits on the store lock is not redelivered — a lapsed claim is found by key', async () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const e1 = await queued(a, 'the first team fact of a slow batch')
    const e2 = await queued(a, 'the second team fact of a slow batch')
    const gates: Array<() => void> = []
    let arrivals = 0
    server.appendHook = async () => { arrivals++; await new Promise<void>(r => gates.push(r)) }
    const clock = shiftClock()
    try {
      const flushingA = a.flushOutbox()
      await waitFor(() => arrivals === 1, "A's first POST")
      clock.add(30_000) // the POST takes its full request bound
      gates[0]()
      await waitFor(() => arrivals === 2, "A's second POST")
      // A long lock holder takes the store lock; A's second POST lands and
      // its merge-back queues behind the lock.
      const lock = await holdStoreLock()
      clock.add(30_000)
      gates[1]()
      await new Promise(r => setTimeout(r, 50))
      // The lock is held for the whole acquire bound: A's claims lapse.
      clock.add(DEFAULT_ACQUIRE_TIMEOUT)
      server.appendHook = null // any later POST (a redelivery) answers at once
      const flushingB = b.flushOutbox()
      await new Promise(r => setTimeout(r, 50))
      await lock.release()
      const rb = await flushingB
      const ra = await flushingA
      // Decision C3: B took the lapsed claims over, marked the entries in
      // doubt and found both on the server by their keys instead of POSTing
      // them again; whichever merge-back runs first hands them off.
      expect(server.appendCalls, 'a statement was delivered twice').toBe(2)
      expect(ra.flushed + rb.flushed).toBeGreaterThanOrEqual(2)
      expect(rowOf(e1.id)).toBeUndefined()
      expect(rowOf(e2.id)).toBeUndefined()
    } finally { clock.restore(); for (const g of gates) g() }
  })

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

  it('finding 4: a flush that throws mid-way leaves no lease and no claim behind', async () => {
    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact whose flush blows up mid-way')
    ;(a as any)._getRemoteDriver = () => { throw new Error('driver construction failed') }
    await expect(a.flushOutbox()).rejects.toThrow('driver construction failed')
    expect(rowOf(e.id)?.structured_data?._outboxLease, 'a lease outlived the flush that took it').toBeUndefined()
    expect(existsSync(claimOf(a, e.id)), 'a claim outlived the flush that took it').toBe(false)
    expect(rowOf(e.id)?.structured_data?._outbox).toBeTruthy()
    const r = await new Plur({ path: dir }).flushOutbox()
    expect(r.flushed).toBe(1)
  })

  // ---- Review of #1231 (2026-09-28) ------------------------------------------

  it("a failed learn() push and flushes racing it deliver the row once (decision C3: the claim guards it)", async () => {
    // A's learn() push fails; before its bookkeeping write, a flush in A takes
    // the store lock. Releasing by holder id (and the in-flight claim before
    // that write) let the flush re-lease and POST the row, and then the failed
    // push's bookkeeping removed the flush's lease: B saw the row unleased
    // while A's POST was on the wire and delivered it a second time.
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    let failFirst!: () => void
    const firstGate = new Promise<void>(r => { failFirst = r })
    let releaseSecond!: () => void
    const secondGate = new Promise<void>(r => { releaseSecond = r })
    let arrivals = 0
    server.appendHook = async (n: number) => {
      arrivals = n
      if (n === 1) { await firstGate; server.appendErrorResponse = { status: 503, body: 'down' }; return }
      server.appendErrorResponse = null
      if (n === 2) await secondGate
    }
    try {
      const e = await a.learn('a team fact whose first push fails', { scope: SCOPE, type: 'behavioral' })
      await waitFor(() => arrivals === 1, "learn()'s POST to be on the wire")
      // The flush queues on the store lock AHEAD of the failed push's bookkeeping.
      const lock = await holdStoreLock()
      const flushingA = a.flushOutbox()
      await new Promise(r => setTimeout(r, 30))
      failFirst()
      await new Promise(r => setTimeout(r, 100)) // the failure reaches learn(), which waits for the lock
      await lock.release()
      await waitFor(() => rowOf(e.id)?.structured_data?._outbox?.attempt_count === 1, "the failed push's bookkeeping")
      await waitFor(() => !existsSync(claimOf(a, e.id)), 'the failed push to release its claim')
      const flushingB = b.flushOutbox()
      await new Promise(r => setTimeout(r, 50))
      releaseSecond()
      await flushingB
      await flushingA
      const accepted = (server as any).engrams as Map<string, { data: { statement?: string } }>
      const copies = [...accepted.values()].filter(x => x.data.statement === 'a team fact whose first push fails')
      expect(copies.length, 'the remote accepted the same engram twice').toBe(1)
      expect(rowOf(e.id), 'the delivered row is handed off').toBeUndefined()
    } finally { failFirst(); releaseSecond() }
  })

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
      expect(rowOf(e.id)?.structured_data?._outboxLease, 'the failed push released its lease').toBeUndefined()
    } finally { failFirst() }
  })

  it("listOutbox reports leased_until (advisory, from the claim) for a row being pushed now, this instance's own push included", async () => {
    const a = new Plur({ path: dir })
    const e = await queued(a, 'a team fact listed while its push is on the wire')
    const hold = holdNextAppend()
    const flushing = a.flushOutbox()
    await waitFor(hold.arrived, 'the POST to be on the wire')
    const own = (await a.listOutbox()).find(x => x.id === e.id)
    const other = (await new Plur({ path: dir }).listOutbox()).find(x => x.id === e.id)
    expect(own?.leased_until).toBeTruthy()
    expect(other?.leased_until).toBe(own?.leased_until)
    expect(rowOf(e.id)?.structured_data?._outboxLease, 'the push wrote a row lease').toBeUndefined()
    hold.release()
    await flushing
  })
})

describe('outbox-lease helpers', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z')
  const sd = (holder: string, msFromNow: number) =>
    ({ _outboxLease: { holder, expires_at: new Date(now + msFromNow).toISOString() } })

  it('unleased, own, expired and malformed leases are free; a live foreign one is not', () => {
    expect(leaseFree(undefined, 'me', now)).toBe(true)
    expect(leaseFree({}, 'me', now)).toBe(true)
    expect(leaseFree(sd('me', 60_000), 'me', now)).toBe(true)
    expect(leaseFree(sd('other', 0), 'me', now)).toBe(true)
    expect(leaseFree({ _outboxLease: { holder: 'other', expires_at: 'not a date' } }, 'me', now)).toBe(true)
    expect(leaseFree(sd('other', 60_000), 'me', now)).toBe(false)
  })

  it('a lease further out than TTL + margin cannot block (one bad write does not park a row forever)', () => {
    expect(leaseFree(sd('other', OUTBOX_LEASE_TTL_MS + OUTBOX_LEASE_MARGIN_MS), 'me', now)).toBe(false)
    expect(leaseFree(sd('other', OUTBOX_LEASE_TTL_MS + OUTBOX_LEASE_MARGIN_MS + 1), 'me', now)).toBe(true)
  })

  it('the margin covers a request, the store-lock wait, the merge-back write and the skew (audit of #1231)', () => {
    expect(OUTBOX_LEASE_MARGIN_MS).toBeGreaterThanOrEqual(30_000 + DEFAULT_ACQUIRE_TIMEOUT + 60_000)
    expect(OUTBOX_LEASE_MARGIN_MS).toBeLessThan(OUTBOX_LEASE_TTL_MS)
  })

  it('a push starts only while the margin still fits in the lease', () => {
    const until = now + OUTBOX_LEASE_TTL_MS
    expect(canStartPush(until, now)).toBe(true)
    expect(canStartPush(until, until - OUTBOX_LEASE_MARGIN_MS)).toBe(true)
    expect(canStartPush(until, until - OUTBOX_LEASE_MARGIN_MS + 1)).toBe(false)
  })

  it('a release drops only the exact lease it wrote, not another lease of the same holder', () => {
    const holder = newLeaseHolder()
    const mine = makeLease(holder, now)
    const later = makeLease(holder, now) // a second push by the same instance
    expect(later.nonce).not.toBe(mine.nonce)
    const row = { _outboxLease: { ...later } } as Record<string, unknown>
    expect(dropLease(row, mine), 'released another push of the same holder').toBe(false)
    expect(row._outboxLease).toEqual(later)
    expect(dropLease(row, makeLease('someone-else', now))).toBe(false)
    expect(dropLease(row, later)).toBe(true)
    expect(row._outboxLease).toBeUndefined()
    // A lease from a client that predates the nonce is never released by one that has it.
    const old = { _outboxLease: { holder, expires_at: mine.expires_at } } as Record<string, unknown>
    expect(dropLease(old, mine)).toBe(false)
    expect(newLeaseHolder()).not.toBe(newLeaseHolder())
  })

  it('the margin must be shorter than the TTL, or no push could ever start', () => {
    expect(() => assertLeaseMarginFits(OUTBOX_LEASE_MARGIN_MS, OUTBOX_LEASE_TTL_MS)).not.toThrow()
    expect(() => assertLeaseMarginFits(OUTBOX_LEASE_TTL_MS, OUTBOX_LEASE_TTL_MS)).toThrow(/shorter than its TTL/)
    expect(() => assertLeaseMarginFits(OUTBOX_LEASE_TTL_MS + 1, OUTBOX_LEASE_TTL_MS)).toThrow()
  })
})
