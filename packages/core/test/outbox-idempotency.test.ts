/**
 * Idempotency keys for remote writes: audit follow-up to #1277 (the
 * 2026-09-29 data-loss and adversarial audits of #1269).
 *
 * The key must be unique per LOGICAL write and stable across that write's
 * retries. #1277 first derived it from the engram id, which is `__pending__`
 * on every direct team write and a per-day sequence on queued ones. A server
 * following docs/remote-store-contract.md therefore collapsed unrelated writes
 * into the first one, and the client reported them delivered.
 *
 * Every test builds on the audits' repros against a real-HTTP stub that can
 * behave like a contract-following server. Temp store and HOME only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'idem-token'
const SCOPE = 'group:test'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

describe('remote-write idempotency keys (audit follow-up to #1277)', () => {
  let root: string
  let prevHome: string | undefined

  function makeStore(name: string): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [{ url: baseUrl, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
    }))
    return dir
  }

  beforeEach(() => {
    server.reset()
    root = mkdtempSync(join(tmpdir(), 'plur-idem-'))
    prevHome = process.env.HOME
    process.env.HOME = join(root, 'home')
  })
  afterEach(() => {
    process.env.HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  })

  async function queue(plur: Plur, statement: string): Promise<string> {
    server.appendErrorResponse = { status: 503, body: 'down for the test' }
    const e = await plur.learnRouted(statement, { scope: SCOPE, type: 'behavioral' })
    server.appendErrorResponse = null
    return e.id
  }

  it('F1: direct team writes each carry their own key, so a key-honouring server keeps them all', async () => {
    server.honourIdempotency = true
    const plur = new Plur({ path: makeStore('a') })
    const statements = [
      'Deploys to staging need a green canary first',
      'The billing service retries webhooks three times',
      'Use pnpm, never npm, in the monorepo',
    ]
    for (const st of statements) await plur.learnRouted(st, { scope: SCOPE, type: 'behavioral' })

    expect(server.engramCount).toBe(3)
    expect(new Set(server.appendKeys).size).toBe(3)
    for (const k of server.appendKeys) expect(k).toMatch(UUID)
  })

  it('F1: the fire-and-forget learn() push carries a random key too', async () => {
    server.honourIdempotency = true
    const plur = new Plur({ path: makeStore('a') })
    await plur.learn('Rollbacks are announced in the incident channel', { scope: SCOPE, type: 'behavioral' })
    await plur.learn('Feature flags are removed within two sprints', { scope: SCOPE, type: 'behavioral' })
    await waitFor(async () => server.engramCount === 2)
    await backgroundPushesSettled(join(root, 'a'))
    for (const k of server.appendKeys) expect(k).toMatch(UUID)
  })

  it('F2: two machines sharing one token do not collide on the key', async () => {
    server.honourIdempotency = true
    const laptop = new Plur({ path: makeStore('laptop') })
    const desktop = new Plur({ path: makeStore('desktop') })
    const a = await queue(laptop, 'Laptop: the VPN config lives in infra/vpn')
    const b = await queue(desktop, 'Desktop: the build cache lives in /var/cache/ci')
    expect(a).toBe(b) // same per-day local id on both machines — the audit's premise

    expect((await laptop.flushOutbox()).flushed).toBe(1)
    expect((await desktop.flushOutbox()).flushed).toBe(1)
    expect(server.engramCount).toBe(2)
  })

  it('the key is minted once per write and reused on every retry of that write', async () => {
    const plur = new Plur({ path: makeStore('a') })
    await queue(plur, 'Retries reuse the key')
    server.appendDelayMs = 10_000
    server.appendDropWhileDelayed = true
    await plur.flushOutbox({ timeoutMs: 200 })
    server.appendDelayMs = 0
    server.appendDropWhileDelayed = false
    await plur.flushOutbox({ timeoutMs: 5_000 })

    const keys = server.appendKeys.filter(Boolean)
    expect(keys.length).toBeGreaterThanOrEqual(2)
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toMatch(UUID)
  })

  it("F3: an in-doubt entry is not 'delivered' by a teammate's engram with the same statement", async () => {
    const plur = new Plur({ path: makeStore('me') })
    const S = 'Rotate the on-call pager key every quarter'
    const mine = await queue(plur, S)

    // A budget-cut flush: the slow server drops the write when we give up.
    server.appendDelayMs = 10_000
    server.appendDropWhileDelayed = true
    await plur.flushOutbox({ timeoutMs: 200 })
    server.appendDelayMs = 0
    server.appendDropWhileDelayed = false
    expect(server.engramCount).toBe(0)

    // A teammate saves the same sentence.
    server.seedEngram({ id: 'ENG-TEAMMATE-1', scope: SCOPE, status: 'active', data: { statement: S, type: 'behavioral' } })

    const result = await plur.flushOutbox({ timeoutMs: 5_000 })
    expect(result.flushed).toBe(1)
    expect(server.engramCount).toBe(2) // ours was actually posted
    expect(await plur.outboxCount()).toBe(0)
    expect(mine).toBeTruthy()
  })

  it('F4: an in-doubt entry in a scope with more than 10,000 rows is still delivered', async () => {
    for (let i = 0; i < 10_050; i++) {
      server.seedEngram({ id: `ENG-OLD-${i}`, scope: SCOPE, status: 'active', data: { statement: `older team fact ${i}`, type: 'behavioral' } })
    }
    const plur = new Plur({ path: makeStore('a') })
    await queue(plur, 'Incidents get a written review within five days')
    server.appendDelayMs = 10_000
    server.appendDropWhileDelayed = true
    await plur.flushOutbox({ timeoutMs: 200 })
    server.appendDelayMs = 0
    server.appendDropWhileDelayed = false

    const result = await plur.flushOutbox({ timeoutMs: 10_000 })
    expect(result.flushed).toBe(1)
    expect(await plur.outboxCount()).toBe(0)
  })

  it("M6: a flush does not push an entry while learn()'s background push of it is in flight", async () => {
    const plur = new Plur({ path: makeStore('a') })
    // Slow but successful, and the server does NOT honour keys: only mutual
    // exclusion on the client can prevent a second copy.
    server.appendDelayMs = 400
    await plur.learn('Background push races the flush', { scope: SCOPE, type: 'behavioral' })
    // learn() has returned; its push is in flight. Flush now.
    await plur.flushOutbox({ timeoutMs: 5_000 })
    await waitFor(async () => (await plur.outboxCount()) === 0, 5_000)
    await backgroundPushesSettled(join(root, 'a'))
    await new Promise(r => setTimeout(r, 600)) // let any second POST land
    expect(server.engramCount).toBe(1)
  })

  it('F4: when the server cannot confirm by key, the entry is kept, never deleted, and surfaced as needing action', async () => {
    server.ignoreIdempotencyKeys = true
    const plur = new Plur({ path: makeStore('a') })
    const id = await queue(plur, 'Unconfirmable write')
    server.appendDelayMs = 10_000
    server.appendDropWhileDelayed = true
    await plur.flushOutbox({ timeoutMs: 200 })
    server.appendDelayMs = 0
    server.appendDropWhileDelayed = false
    // Same statement on the server from someone else: must NOT count as ours.
    server.seedEngram({ id: 'ENG-OTHER', scope: SCOPE, status: 'active', data: { statement: 'Unconfirmable write', type: 'behavioral' } })

    for (let i = 0; i < 6; i++) {
      const r = await plur.flushOutbox({ timeoutMs: 5_000 })
      expect(r.flushed).toBe(0)
    }
    expect(await plur.outboxCount()).toBe(1)
    const [entry] = await plur.listOutbox()
    expect(entry.id).toBe(id)
    expect(entry.state).toBe('needs_action')
    expect(entry.reason).toMatch(/could not confirm/i)
    expect(entry.next_step).toContain(`plur outbox --resend ${id}`)
    // An explicit forced flush does not post it either: only a resend does.
    expect((await plur.flushOutbox({ force: true })).flushed).toBe(0)

    // The explicit way out: resend it on purpose.
    const r = await plur.flushOutbox({ resend: [id] })
    expect(r.flushed).toBe(1)
    expect(await plur.outboxCount()).toBe(0)
  })
})
