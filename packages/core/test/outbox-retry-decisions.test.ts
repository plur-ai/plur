/**
 * Owner decisions C3 and C4 (round-2 board) on outbox delivery.
 *
 * C3: per-entry claims are the one duplicate-push guard, and taking over a
 * stale claim must be atomic — the claim path is never empty during a
 * takeover, so no second claimer can slip in a fresh claim.
 *
 * C4: "a timed-out or thrown push is not 'maybe delivered'. It should
 * re-try." There is no in-doubt state and no lookup before a re-post. The
 * idempotency key is what makes a retry safe: minted when the write is
 * queued, persisted on the outbox row before the first POST (rows from older
 * clients included), reused on every retry — also after a merge-back throws.
 *
 * Real-HTTP stub, temp store and HOME only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, hostname } from 'os'
import { spawnSync } from 'child_process'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'decisions-token'
const SCOPE = 'group:test'

let server: StubServer
let baseUrl: string
beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

describe('outbox decisions C3 and C4', () => {
  let root: string
  let dir: string
  let prevHome: string | undefined

  beforeEach(() => {
    server.reset()
    root = mkdtempSync(join(tmpdir(), 'plur-decisions-'))
    prevHome = process.env.HOME
    process.env.HOME = join(root, 'home')
    dir = join(root, 'store')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [{ url: baseUrl, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
    }))
  })
  afterEach(async () => {
    await backgroundPushesSettled(dir).catch(() => {})
    process.env.HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  })

  async function queue(plur: Plur, statement: string): Promise<string> {
    server.appendErrorResponse = { status: 503, body: 'down for the test' }
    const e = await plur.learnRouted(statement, { scope: SCOPE, type: 'behavioral' })
    server.appendErrorResponse = null
    return e.id
  }

  function outboxRow(id: string): any {
    const doc = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as { engrams: any[] }
    return doc.engrams.find(e => e.id === id)?.structured_data?._outbox
  }

  // ---- C3 -----------------------------------------------------------------

  it('C3: taking over a stale claim never leaves the path free for a fresh claim', async () => {
    const plur = new Plur({ path: dir }) as any
    const id = 'ENG-2026-09-29-900'
    const claimPath = join(dir, 'cache', 'outbox-claims', `${id}.json`)
    mkdirSync(join(dir, 'cache', 'outbox-claims'), { recursive: true })
    // A stale claim: its owner process has exited (a live same-host owner
    // keeps its claim however long its push runs).
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    writeFileSync(claimPath, JSON.stringify({ key: 'k-stale', pid: deadPid, host: hostname(), until: Date.now() - 60_000 }))

    // A second claimer arrives while the first is mid-takeover.
    let nested: any
    let pathPresentMidTakeover: boolean | undefined
    const outer = plur._claimOutboxEntry(id, () => {
      pathPresentMidTakeover = existsSync(claimPath)
      nested = plur._claimOutboxEntry(id, () => 'k-nested')
      return 'k-outer'
    })

    // The claim path is never empty during a takeover, so a second claimer
    // can only take over the stale claim, never slip a fresh one into a gap…
    expect(pathPresentMidTakeover, 'the takeover left the claim path empty').toBe(true)
    // …and never do both win.
    expect([outer.status, nested.status].filter(s => s === 'claimed')).toHaveLength(1)
  })

  it('C3: a POST held open past the claim lease is not re-pushed by a concurrent flush while its owner is alive', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 'Held open past the lease')
    const claimPath = join(dir, 'cache', 'outbox-claims')

    // Flush A: its POST is held open by a slow (but alive) server.
    server.appendDelayMs = 2_000
    const a = plur.flushOutbox()
    const until = Date.now() + 5_000
    let file: string | undefined
    while (!file && Date.now() < until) {
      try { file = readdirSync(claimPath).find(f => f.endsWith('.json')) } catch { /* not yet */ }
      if (!file) await new Promise(r => setTimeout(r, 10))
    }
    expect(file, 'flush A never claimed the entry').toBeDefined()
    while (server.appendKeys.length === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 10))
    expect(server.appendKeys).toHaveLength(1)

    // Time passes beyond the old 60s lease while A's POST is still open.
    const claim = JSON.parse(readFileSync(join(claimPath, file!), 'utf8'))
    claim.until = Date.now() - 1_000
    writeFileSync(join(claimPath, file!), JSON.stringify(claim))

    // Flush B, same live process: must leave the entry to A.
    const b = await new Plur({ path: dir }).flushOutbox()
    expect(b.flushed).toBe(0)
    expect(server.appendKeys, 'a second flusher re-pushed the same entry').toHaveLength(1)

    await a
    expect(server.engramCount).toBe(1)
    expect(await plur.outboxCount()).toBe(0)
  })

  it('C3: a live-owner claim still lapses after the hard age cap (pid reuse cannot block an entry forever)', async () => {
    const plur = new Plur({ path: dir }) as any
    const id = 'ENG-2026-09-29-901'
    const claimsDir = join(dir, 'cache', 'outbox-claims')
    mkdirSync(claimsDir, { recursive: true })
    const old = Date.now() - 16 * 60_000
    writeFileSync(join(claimsDir, `${id}.json`), JSON.stringify({
      key: 'k', pid: process.pid, host: hostname(), at: old, until: old + 60_000,
    }))
    expect(plur._claimOutboxEntry(id, () => 'k2').status).toBe('claimed')
  })

  // ---- C4 -----------------------------------------------------------------

  it('C4: a push cut after the server stored it is simply retried, with the same key, and never marked in doubt', async () => {
    const plur = new Plur({ path: dir })
    const id = await queue(plur, 'Cut after the server stored it')
    server.appendDelayMs = 10_000 // stored on receipt, answered late
    await plur.flushOutbox({ timeoutMs: 200 })
    expect(outboxRow(id)?.in_doubt).toBeUndefined()

    server.appendDelayMs = 0
    const r = await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(r.flushed).toBe(1)
    const keys = server.appendKeys.filter(Boolean)
    expect(keys).toHaveLength(2) // re-posted, not looked up
    expect(new Set(keys).size).toBe(1)
    expect(await plur.outboxCount()).toBe(0)
  })

  it('C4: on a key-honouring server that retry leaves exactly one row', async () => {
    server.honourIdempotency = true
    const plur = new Plur({ path: dir })
    await queue(plur, 'Honoured retry')
    server.appendDelayMs = 10_000
    await plur.flushOutbox({ timeoutMs: 200 })
    server.appendDelayMs = 0
    await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(server.engramCount).toBe(1)
    expect(await plur.outboxCount()).toBe(0)
  })

  it('C4: a row queued by an older client gets its key persisted BEFORE the first POST, and keeps it after a merge-back throws', async () => {
    server.honourIdempotency = true
    const plur = new Plur({ path: dir })
    const id = await queue(plur, 'Queued by an older client')
    // Simulate the older client: no key on the row.
    const file = join(dir, 'engrams.yaml')
    const doc = yaml.load(readFileSync(file, 'utf8')) as { engrams: any[] }
    delete doc.engrams.find(e => e.id === id).structured_data._outbox.idempotency_key
    writeFileSync(file, yaml.dump(doc))
    const fresh = new Plur({ path: dir }) as any

    // The POST lands; the merge-back then throws (a store-lock timeout, a
    // full disk). The key must already be on the row.
    const real = fresh._writeEngrams.bind(fresh)
    let thrown = false
    fresh._writeEngrams = async (path: string, engrams: unknown, opts?: { allowShrink?: boolean }) => {
      if (opts?.allowShrink && !thrown) { thrown = true; throw new Error('disk full (test)') }
      return real(path, engrams, opts)
    }
    await expect(fresh.flushOutbox({ timeoutMs: 5_000 })).rejects.toThrow(/disk full/)
    expect(thrown).toBe(true)
    const persisted = outboxRow(id)?.idempotency_key
    expect(persisted).toBe(server.appendKeys.filter(Boolean)[0])

    // Next flush: same key, so the honouring server keeps one row.
    const r = await fresh.flushOutbox({ timeoutMs: 5_000 })
    expect(r.flushed).toBe(1)
    const keys = server.appendKeys.filter(Boolean)
    expect(new Set(keys).size).toBe(1)
    expect(server.engramCount).toBe(1)
  })

  it('C4: a push that throws a remote timeout is retried on the next flush, not held', async () => {
    const plur = new Plur({ path: dir }) as any
    const id = await queue(plur, 'Timed out push')
    const realFetch = globalThis.fetch
    let first = true
    globalThis.fetch = (async (input: any, init?: any) => {
      if ((init?.method ?? 'GET') === 'POST' && first) {
        first = false
        await realFetch(input, init) // reaches the server
        const { RemoteTimeoutError } = await import('../src/store/remote-store.js')
        throw new RemoteTimeoutError(String(input), 30_000)
      }
      return realFetch(input, init)
    }) as typeof fetch
    try {
      await plur.flushOutbox({ timeoutMs: 5_000 })
      expect(outboxRow(id)?.in_doubt).toBeUndefined()
      const r = await plur.flushOutbox({ timeoutMs: 5_000 })
      expect(r.flushed).toBe(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
