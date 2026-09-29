/**
 * Formal cluster 3 (field report 2026-09-29) — outbox delivery replays.
 *
 * Model: spec/formal/PlurSpec/Outbox.lean. Findings: spec/formal/findings/outbox.md.
 *
 * Each `it.fails` is a CONFIRMED counterexample replayed against the real code:
 * the test states the intended behaviour and currently fails. It flips to a
 * normal pass (and `it.fails` then reports it) once the defect is fixed, so
 * the fix PR changes `it.fails` to `it`. Plain `it` cases pin the good cases
 * the model proves. Temp HOME / PLUR_PATH and the in-process stub server only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { RemoteTimeoutError, _resetRemoteHostBreaker } from '../src/store/remote-store.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'fr-c3-token'
const SCOPE = 'group:test'

let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

describe('formal cluster 3: exactly-once delivery of outbox writes', () => {
  let root: string
  let dir: string
  let prevHome: string | undefined
  let prevPath: string | undefined
  const realFetch = globalThis.fetch

  beforeEach(() => {
    server.reset()
    _resetRemoteHostBreaker()
    root = mkdtempSync(join(tmpdir(), 'plur-fr-c3-'))
    dir = join(root, 'store')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      embeddings: { enabled: false },
      stores: [{ url: baseUrl, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
    }))
    prevHome = process.env.HOME
    prevPath = process.env.PLUR_PATH
    process.env.HOME = join(root, 'home')
    process.env.PLUR_PATH = dir
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    process.env.HOME = prevHome
    if (prevPath === undefined) delete process.env.PLUR_PATH
    else process.env.PLUR_PATH = prevPath
    rmSync(root, { recursive: true, force: true })
  })

  /** The next POST /engrams reaches the server (it is stored) but the client
   *  sees a RemoteTimeoutError — "a timeout after the server stored it". */
  function timeOutAfterStoringNextPost(): void {
    let armed = true
    globalThis.fetch = (async (url: any, init?: any) => {
      const res = await realFetch(url, init)
      if (armed && init?.method === 'POST' && /\/api\/v1\/engrams$/.test(String(url))) {
        armed = false
        await res.text()
        throw new RemoteTimeoutError(String(url), 30_000)
      }
      return res
    }) as typeof fetch
  }

  /** engrams.yaml is either a bare list or `{ engrams: [...] }`. */
  function readRows(plur: Plur): any[] {
    const doc = yaml.load(readFileSync((plur as any).paths.engrams, 'utf8')) as any
    return Array.isArray(doc) ? doc : (doc?.engrams ?? [])
  }

  function outboxOf(plur: Plur, id: string): Record<string, unknown> | undefined {
    return readRows(plur).find(e => e.id === id)?.structured_data?._outbox
  }

  // ── Candidate 1a: first-leg timeout is not recorded as in doubt ───────────

  it.fails('C1a (Outbox.firstLeg_timeout_dup): a learnRouted() write that timed out after the server stored it is not posted again unprobed (key-ignoring server)', async () => {
    server.ignoreIdempotencyKeys = true
    const plur = new Plur({ path: dir })
    timeOutAfterStoringNextPost()
    const e = await plur.learnRouted('Direct write whose answer was lost', { scope: SCOPE, type: 'behavioral' })
    globalThis.fetch = realFetch
    expect(server.engramCount).toBe(1) // the write landed
    expect(e.id).not.toBe('__pending__') // queued locally for retry
    // docs/remote-store-contract.md: a timed-out write is in doubt, so the
    // flush must look it up by key before posting — never post it blind.
    await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(server.engramCount).toBe(1) // no second copy
  })

  it('C1a good case (Outbox.honour_exactly_once): the same replay against a key-honouring server stays at one row', async () => {
    server.honourIdempotency = true
    const plur = new Plur({ path: dir })
    timeOutAfterStoringNextPost()
    await plur.learnRouted('Direct write whose answer was lost, honouring server', { scope: SCOPE, type: 'behavioral' })
    globalThis.fetch = realFetch
    const r = await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(r.flushed).toBe(1)
    expect(server.engramCount).toBe(1)
    expect(new Set(server.appendKeys).size).toBe(1) // one key across both POSTs
    expect(await plur.outboxCount()).toBe(0)
  })

  // ── Candidate 1b / 2: a thrown merge-back releases an in-doubt claim ──────

  /** Queue one entry (learnRouted against a 503), optionally stripping its key
   *  to model an entry queued by a client that predates idempotency keys. */
  async function queueEntry(plur: Plur, statement: string, stripKey: boolean): Promise<string> {
    server.appendErrorResponse = { status: 503, body: 'down for the test' }
    const e = await plur.learnRouted(statement, { scope: SCOPE, type: 'behavioral' })
    server.appendErrorResponse = null
    if (stripKey) {
      const path = (plur as any).paths.engrams
      const doc = yaml.load(readFileSync(path, 'utf8')) as any
      const rows: any[] = Array.isArray(doc) ? doc : doc.engrams
      let stripped = 0
      for (const r of rows) if (r.id === e.id) { delete r.structured_data._outbox.idempotency_key; stripped++ }
      expect(stripped).toBe(1)
      writeFileSync(path, yaml.dump(doc))
      expect(outboxOf(plur, e.id)?.idempotency_key).toBeUndefined()
    }
    return e.id
  }

  /** One flush whose POST is stored but cut at the budget, and whose
   *  merge-back write then throws (lock timeout / disk full). */
  async function cutThenFailMergeBack(plur: Plur): Promise<void> {
    server.appendDelayMs = 2_000 // stored at once, answered late
    const orig = (plur as any)._writeEngrams.bind(plur)
    let failed = false
    ;(plur as any)._writeEngrams = async (p: string, rows: unknown, opts?: { allowShrink?: boolean }) => {
      if (!failed && opts?.allowShrink) { failed = true; throw new Error('ENOSPC: simulated merge-back failure') }
      return orig(p, rows, opts)
    }
    await expect(plur.flushOutbox({ timeoutMs: 200 })).rejects.toThrow(/ENOSPC/)
    ;(plur as any)._writeEngrams = orig
    server.appendDelayMs = 0
    await new Promise(r => setTimeout(r, 2_200)) // let the delayed answer drain
    expect(server.engramCount).toBe(1) // the cut POST landed
  }

  it('C1b/C2 (Outbox.thrown_merge_new_key): an entry without a key keeps the key its cut POST carried, even when the merge-back throws (key-honouring server)', async () => {
    server.honourIdempotency = true
    const plur = new Plur({ path: dir })
    await queueEntry(plur, 'Legacy queued write without a key', true)
    await cutThenFailMergeBack(plur)
    await plur.flushOutbox({ timeoutMs: 5_000 })
    // Intended: one logical write, one key, one row.
    expect(new Set(server.appendKeys.filter(Boolean)).size).toBe(1)
    expect(server.engramCount).toBe(1)
  })

  it.fails('C1b (Outbox.thrown_merge_loses_doubt): a cut POST stays in doubt when the merge-back throws (key-ignoring server)', async () => {
    server.ignoreIdempotencyKeys = true
    const plur = new Plur({ path: dir })
    await queueEntry(plur, 'Queued write, cut, merge-back fails', false)
    await cutThenFailMergeBack(plur)
    await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(server.engramCount).toBe(1) // not re-posted unprobed
  })

  it('C1b good case, decision C4: a cut POST whose merge-back succeeds is retried with the same key (key-honouring server: one row)', async () => {
    // Owner decision C4 (2026-09-29): no in-doubt state and no lookup by key —
    // a cut push is retried on the next flush with the key already on its row.
    // A key-honouring server collapses the retry. (Before C4 this pinned the
    // probe: the cut entry was marked in doubt and looked up before a re-post.)
    server.honourIdempotency = true
    const plur = new Plur({ path: dir })
    const id = await queueEntry(plur, 'Queued write, cut, merge-back fine', false)
    server.appendDelayMs = 2_000
    await plur.flushOutbox({ timeoutMs: 200 })
    server.appendDelayMs = 0
    await new Promise(r => setTimeout(r, 2_200))
    expect(outboxOf(plur, id)?.in_doubt).toBeUndefined()
    expect(outboxOf(plur, id)?.idempotency_key).toBeTruthy()
    const r = await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(r.flushed).toBe(1)
    expect(server.engramCount).toBe(1)
    expect(new Set(server.appendKeys.filter(Boolean)).size).toBe(1)
    expect(await plur.outboxCount()).toBe(0)
  })

  it.fails("C1a (Outbox.firstLeg_timeout_dup): learn()'s background push that timed out after the server stored it is not posted again unprobed (key-ignoring server)", async () => {
    server.ignoreIdempotencyKeys = true
    const plur = new Plur({ path: dir })
    timeOutAfterStoringNextPost()
    await plur.learn('Background push whose answer was lost', { scope: SCOPE, type: 'behavioral' })
    await backgroundPushesSettled(dir)
    globalThis.fetch = realFetch
    expect(server.engramCount).toBe(1)
    await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(server.engramCount).toBe(1)
  })

  // ── Conflict I: which mechanism carries "no duplicate"? ───────────────────
  //
  // Process A's flush POSTs, the server stores it, and A then stops for good
  // (killed / abandoned hook) before recording anything: its lease stays on
  // the row and its claim file stays in cache/outbox-claims. Time passing is
  // modelled by expiring the lease (10 min TTL) and the claim (60 s) on disk.

  async function landThenFreeze(statement: string): Promise<{ id: string }> {
    const a = new Plur({ path: dir })
    const id = await queueEntry(a, statement, false)
    let armed = true
    globalThis.fetch = (async (url: any, init?: any) => {
      const res = await realFetch(url, init)
      if (armed && init?.method === 'POST' && /\/api\/v1\/engrams$/.test(String(url))) {
        armed = false
        await res.text()
        return new Promise<Response>(() => {}) // A never sees the answer again
      }
      return res
    }) as typeof fetch
    void a.flushOutbox()
    for (let i = 0; i < 200 && server.engramCount === 0; i++) await new Promise(r => setTimeout(r, 10))
    expect(server.engramCount).toBe(1)
    return { id }
  }

  function expireLease(id: string): void {
    const path = join(dir, 'engrams.yaml')
    const doc = yaml.load(readFileSync(path, 'utf8')) as any
    const rows: any[] = Array.isArray(doc) ? doc : doc.engrams
    const row = rows.find(r => r.id === id)
    // Decision C3 (2026-09-29): the push no longer writes a row lease, so
    // there is none to expire — the claim is the only guard left to vary.
    expect(row.structured_data._outboxLease).toBeUndefined()
    writeFileSync(path, yaml.dump(doc))
  }
  const claimsDir = () => join(dir, 'cache', 'outbox-claims')

  it('conflict I (Outbox.leases_alone_crash_dup): with the lease alone (claim gone), a landed-then-abandoned write is posted again (key-ignoring server)', async () => {
    server.ignoreIdempotencyKeys = true
    const { id } = await landThenFreeze('Abandoned after landing, no claim')
    expireLease(id)
    rmSync(claimsDir(), { recursive: true, force: true }) // the leases-only design
    const b = new Plur({ path: dir })
    await b.flushOutbox({ timeoutMs: 5_000 })
    expect(server.engramCount).toBe(2) // the duplicate the lease cannot prevent
  })

  it('conflict I (Outbox.claims_orphan_probe): with the claim kept, the same write is probed by key and never posted again (key-ignoring server)', async () => {
    server.ignoreIdempotencyKeys = true
    const { id } = await landThenFreeze('Abandoned after landing, claim kept')
    expireLease(id)
    const files = readdirSync(claimsDir())
    expect(files.length).toBe(1)
    const cp = join(claimsDir(), files[0])
    const held = JSON.parse(readFileSync(cp, 'utf8'))
    writeFileSync(cp, JSON.stringify({ ...held, until: Date.now() - 1000 })) // 60 s passed
    const b = new Plur({ path: dir })
    const r = await b.flushOutbox({ timeoutMs: 5_000 })
    expect(r.flushed).toBe(0)
    expect(server.engramCount).toBe(1)
    expect(await b.outboxCount()).toBe(1) // kept, in doubt
  })

  it('conflict I (Outbox.honour_exactly_once): on a key-honouring server neither lease nor claim is needed', async () => {
    server.honourIdempotency = true
    const { id } = await landThenFreeze('Abandoned after landing, honouring server')
    expireLease(id)
    rmSync(claimsDir(), { recursive: true, force: true })
    const b = new Plur({ path: dir })
    const r = await b.flushOutbox({ timeoutMs: 5_000 })
    expect(r.flushed).toBe(1)
    expect(server.engramCount).toBe(1)
    expect(await b.outboxCount()).toBe(0)
  })
})
