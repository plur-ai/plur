/**
 * #1308: a refused write for one scope must not trip the per-host breaker.
 *
 * The write leg feeds the same per-host breaker the recall leg keeps (#785):
 * three consecutive failures open a five-minute cooldown for every scope on
 * that host. A 401/403/404/422 says the REQUEST was wrong (no access to that
 * scope, unknown scope, invalid engram), not that the host is down. Counting
 * it let a few refused writes to scope A block healthy writes to scope B on
 * the same server.
 *
 * Network errors, timeouts and 5xx still count.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { isHostInCooldown, BREAKER_FAILURE_THRESHOLD } from '../src/remote-recall.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'outbox-breaker-refusal-token'
const SCOPE_A = 'group:example/eng'
const SCOPE_B = 'group:example/ops'

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

describe('a scope refusal does not open the host breaker (#1308)', () => {
  let dir: string
  let savedHome: string | undefined
  let savedPlurPath: string | undefined

  beforeEach(() => {
    server.reset()
    dir = mkdtempSync(join(tmpdir(), 'plur-breaker-refusal-'))
    savedHome = process.env.HOME
    savedPlurPath = process.env.PLUR_PATH
    process.env.HOME = dir
    process.env.PLUR_PATH = dir
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      embeddings: { enabled: false },
      stores: [
        { url: baseUrl, token: TOKEN, scope: SCOPE_A, shared: true, readonly: false },
        { url: baseUrl, token: TOKEN, scope: SCOPE_B, shared: true, readonly: false },
      ],
    }))
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedPlurPath === undefined) delete process.env.PLUR_PATH
    else process.env.PLUR_PATH = savedPlurPath
    rmSync(dir, { recursive: true, force: true })
  })

  /** Queue one engram for `scope`; the initial push fails and it lands in the outbox. */
  async function queue(plur: Plur, scope: string, statement: string): Promise<string> {
    const e = await plur.learnRouted(statement, { scope, type: 'behavioral' })
    await waitFor(async () => (await plur.listOutbox()).some(x => x.id === e.id))
    return e.id
  }

  /**
   * N engrams for scope A (queued first, so flushed first) and one for B.
   * `refuseA` is what the server answers every write to A with during the
   * flush; B is accepted.
   */
  async function flushAfterFailuresOnA(refuseA: { status: number; body: string }) {
    const plur = new Plur({ path: dir })
    server.appendErrorByScope = { [SCOPE_A]: refuseA }
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD + 1; i++) {
      await queue(plur, SCOPE_A, `scope A fact number ${i}`)
    }
    // B's initial push fails too (a transient 503), so it waits in the outbox
    // behind A's entries. The initial routed push does not feed the breaker.
    server.appendErrorResponse = { status: 503, body: 'down for the test' }
    const bId = await queue(plur, SCOPE_B, 'scope B fact')
    server.appendErrorResponse = null
    server.appendCalls = 0

    // Forced, so A's needs_action entries are dialled rather than backed off.
    const res = await plur.flushOutbox({ force: true })
    const left = await plur.listOutbox()
    return { plur, res, bId, left }
  }

  for (const status of [401, 403, 404, 422]) {
    it(`${status} refusals to scope A do not short-circuit a write to scope B on the same host`, async () => {
      const { res, bId, left } = await flushAfterFailuresOnA({ status, body: `Cannot write to scope ${SCOPE_A}` })
      // Every A entry was dialled and refused, and B was then sent, not skipped.
      expect(server.appendCalls).toBe(BREAKER_FAILURE_THRESHOLD + 2)
      expect(server.lastAppendBody?.scope).toBe(SCOPE_B)
      expect(res.flushed).toBe(1)
      expect(res.expired_warnings.some(w => w.includes('circuit breaker open'))).toBe(false)
      expect(left.some(e => e.id === bId)).toBe(false)
      expect(isHostInCooldown(baseUrl, Date.now(), join(dir, 'cache', 'remote-health.json')).inCooldown).toBe(false)
    })
  }

  it('5xx failures on scope A still open the breaker for the host', async () => {
    const { res, bId, left } = await flushAfterFailuresOnA({ status: 503, body: 'down' })
    // The breaker opens after the threshold: the rest of A and all of B are skipped.
    expect(server.appendCalls).toBe(BREAKER_FAILURE_THRESHOLD)
    expect(res.flushed).toBe(0)
    expect(res.expired_warnings.some(w => w.includes('circuit breaker open'))).toBe(true)
    expect(left.some(e => e.id === bId)).toBe(true)
    expect(isHostInCooldown(baseUrl, Date.now(), join(dir, 'cache', 'remote-health.json')).inCooldown).toBe(true)
  })

  it('a refusal does not reset a count built by real failures either', async () => {
    // The refusal says nothing about the host either way: two 5xx then a 403
    // leaves the count at two, so one more 5xx opens the breaker.
    const plur = new Plur({ path: dir })
    server.appendErrorByScope = { [SCOPE_A]: { status: 503, body: 'down' } }
    await queue(plur, SCOPE_A, 'transient one')
    await queue(plur, SCOPE_A, 'transient two')
    server.appendErrorByScope = { [SCOPE_B]: { status: 403, body: `Cannot write to scope ${SCOPE_B}` } }
    await queue(plur, SCOPE_B, 'refused one')
    server.appendErrorByScope = { [SCOPE_A]: { status: 503, body: 'down' } }
    await queue(plur, SCOPE_A, 'transient three')

    server.appendErrorByScope = {
      [SCOPE_A]: { status: 503, body: 'down' },
      [SCOPE_B]: { status: 403, body: `Cannot write to scope ${SCOPE_B}` },
    }
    // Order: 503, 503, 403, 503 — the breaker opens on the third 5xx.
    await plur.flushOutbox({ force: true })
    expect(isHostInCooldown(baseUrl, Date.now(), join(dir, 'cache', 'remote-health.json')).inCooldown).toBe(true)
  })
})
