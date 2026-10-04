/**
 * Decision C3, measured the way the review of #1277 measured it: SEPARATE
 * PROCESSES against a stub that counts every POST and ignores the
 * idempotency key. On such a server a second push of an entry is a second
 * row, so these tests see every duplicate the claim failed to stop.
 *
 * 1. A claim does not make a stale snapshot current. A flush that reaches an
 *    entry after another writer pushed it, removed the row and released the
 *    claim must not push it again: after taking the claim it re-reads the row
 *    and skips it when it is gone or carries a different key.
 * 2. Taking over a stale claim is a compare-and-swap decided by O_EXCL: of
 *    any number of racers, exactly one wins. A read-compare-rename takeover
 *    (the mutant below) lets several win.
 *
 * Writers run from core's BUILT dist (`pnpm build` runs before the tests in
 * CI). Temp store and temp HOME only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'fs'
import { join } from 'path'
import { tmpdir, hostname } from 'os'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'race-token'
const SCOPE = 'group:test'
const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const CHILD = fileURLToPath(new URL('./helpers/outbox-race-child.cjs', import.meta.url))

let server: StubServer
let baseUrl: string
beforeAll(async () => {
  if (!existsSync(DIST)) throw new Error(`build core first (pnpm --filter @plur-ai/core build): ${DIST} is missing`)
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

let root: string
let dir: string
let home: string
let prevHome: string | undefined
const children: ChildProcess[] = []

beforeEach(() => {
  server.reset() // honourIdempotency = false: the server ignores the key
  root = mkdtempSync(join(tmpdir(), 'plur-claim-races-'))
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  prevHome = process.env.HOME
  process.env.HOME = home
  dir = join(root, 'store')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({
    index: false,
    stores: [{ url: baseUrl, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
  }))
})
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL')
  await backgroundPushesSettled(dir).catch(() => {})
  process.env.HOME = prevHome
  rmSync(root, { recursive: true, force: true })
})

/** Start a writer process. `done` resolves with its stdout, rejects on failure. */
function writer(job: Record<string, unknown>): { done: Promise<string> } {
  const c = spawn(process.execPath, [CHILD, JSON.stringify({ dist: DIST, store: dir, ...job })], {
    env: { ...process.env, HOME: home, PLUR_PATH: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(c)
  let out = ''
  let err = ''
  c.stdout!.on('data', d => { out += d })
  c.stderr!.on('data', d => { err += d })
  const done = new Promise<string>((resolve, reject) => {
    c.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`writer ${String(job.mode)} exited ${code}: ${err}`)))
  })
  return { done }
}

/** Queue a remote write without delivering it (its immediate push is refused). */
async function queue(statement: string): Promise<string> {
  const plur = new Plur({ path: dir })
  server.appendErrorResponse = { status: 503, body: 'down while queueing' }
  const e = await plur.learnRouted(statement, { scope: SCOPE, type: 'behavioral' })
  await backgroundPushesSettled(dir)
  server.appendErrorResponse = null
  return e.id
}

function outboxRowCount(): number {
  const doc = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as { engrams?: any[] } | null
  return (doc?.engrams ?? []).filter(e => e?.structured_data?._outbox).length
}

describe('C3 across processes: a claim is checked against the row, not the snapshot', () => {
  it('two flushers, the second finishing first: one POST per engram', async () => {
    await queue('race two A')
    await queue('race two B')

    // Flusher 1 takes its snapshot and its first POST is held open.
    const hold1 = server.holdNextAppend()
    const f1 = writer({ mode: 'flush' })
    const first = await hold1.arrived
    // Flusher 2 starts later, leaves the held entry to flusher 1, pushes the
    // other one, removes its row, releases its claim — and finishes first.
    await writer({ mode: 'flush' }).done
    // Flusher 1 now reaches that entry with a snapshot that still lists it.
    hold1.release()
    await f1.done

    const other = first === 'race two A' ? 'race two B' : 'race two A'
    expect(server.appendCountFor(first)).toBe(1)
    expect(server.appendCountFor(other), 'the entry was pushed again from a stale snapshot').toBe(1)
    expect(outboxRowCount()).toBe(0)
  }, 60_000)

  it('three flushers: one POST per engram', async () => {
    await queue('race three A')
    await queue('race three B')
    await queue('race three C')

    const hold1 = server.holdNextAppend()
    const f1 = writer({ mode: 'flush' })
    await hold1.arrived
    const hold2 = server.holdNextAppend()
    const f2 = writer({ mode: 'flush' })
    await hold2.arrived
    // Flusher 3 finds the first two entries claimed and pushes the third.
    await writer({ mode: 'flush' }).done
    hold2.release()
    await f2.done
    hold1.release()
    await f1.done

    for (const s of ['race three A', 'race three B', 'race three C']) {
      expect(server.appendCountFor(s), `${s} was pushed more than once`).toBe(1)
    }
    expect(outboxRowCount()).toBe(0)
  }, 60_000)

  it("learn()'s background push plus one flush: one POST per engram", async () => {
    await queue('race learn earlier')

    // The learn's own push is held open while it holds the claim.
    const holdPush = server.holdNextAppend()
    const learner = writer({ mode: 'learn', statement: 'race learn pushed', scope: SCOPE })
    expect(await holdPush.arrived).toBe('race learn pushed')

    // A flush snapshots both rows; its first POST (the earlier entry) is held.
    const holdFlush = server.holdNextAppend()
    const flusher = writer({ mode: 'flush' })
    expect(await holdFlush.arrived).toBe('race learn earlier')

    // The push completes, removes its row, releases its claim.
    holdPush.release()
    await learner.done
    // The flush reaches the pushed engram through its stale snapshot.
    holdFlush.release()
    await flusher.done

    expect(server.appendCountFor('race learn earlier')).toBe(1)
    expect(server.appendCountFor('race learn pushed'), 'the flush re-pushed what learn() had delivered').toBe(1)
    expect(outboxRowCount()).toBe(0)
  }, 60_000)
})

describe('C3 across processes: a stale-claim takeover has exactly one winner', () => {
  const RACERS = 6
  const ROUNDS = 60
  const ID = 'ENG-2026-09-30-777'

  /** Race RACERS processes for one stale claim, ROUNDS times. Winners per round. */
  async function race(impl: 'real' | 'mutant'): Promise<number[]> {
    const sync = join(root, `sync-${impl}`)
    mkdirSync(sync, { recursive: true })
    const claims = join(dir, 'cache', 'outbox-claims')
    mkdirSync(claims, { recursive: true })
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    const racers = Array.from({ length: RACERS }, (_, index) =>
      writer({ mode: 'claim-race', id: ID, rounds: ROUNDS, dir: sync, index, impl }))

    const winners: number[] = []
    for (let r = 0; r < ROUNDS; r++) {
      // A fresh stale claim: its owner process has exited.
      for (const f of readdirSync(claims)) rmSync(join(claims, f), { force: true })
      writeFileSync(join(claims, `${ID}.json`), JSON.stringify({
        key: 'k-stale', token: `stale-${r}`, pid: deadPid, host: hostname(), at: Date.now() - 1_000, until: Date.now() + 59_000,
      }))
      // Racers spin until this instant, so they all fire together. The first
      // round leaves time for the processes to start.
      const tmp = join(sync, `go-${r}.tmp`)
      writeFileSync(tmp, String(Date.now() + (r === 0 ? 1_500 : 40)))
      renameSync(tmp, join(sync, `go-${r}`))
      const until = Date.now() + 30_000
      const results = () => Array.from({ length: RACERS }, (_, i) => join(sync, `res-${r}-${i}`))
      while (!results().every(existsSync)) {
        if (Date.now() > until) throw new Error(`round ${r}: racers did not answer`)
        await new Promise(res => setTimeout(res, 5))
      }
      const statuses = results().map(p => readFileSync(p, 'utf8'))
      expect(statuses.filter(s => s !== 'claimed' && s !== 'busy'), `round ${r}: a racer errored`).toEqual([])
      winners.push(statuses.filter(s => s === 'claimed').length)
    }
    writeFileSync(join(sync, 'done'), '')
    await Promise.all(racers.map(r => r.done))
    return winners
  }

  it(`${RACERS} processes racing for one stale claim: exactly one winner in each of ${ROUNDS} rounds`, async () => {
    const winners = await race('real')
    expect(winners.filter(w => w !== 1), `rounds without exactly one winner: ${JSON.stringify(winners)}`).toEqual([])
  }, 180_000)

  it('the harness sees a non-atomic takeover: the read-compare-rename mutant lets several racers win', async () => {
    const winners = await race('mutant')
    expect(Math.max(...winners), `mutant winners per round: ${JSON.stringify(winners)}`).toBeGreaterThan(1)
  }, 180_000)
})

describe('C3: a takeover marker follows the same liveness rule as a claim', () => {
  const ID = 'ENG-2026-09-30-778'
  const tag = (raw: string) => createHash('sha256').update(raw).digest('hex').slice(0, 16)

  function staleClaimWithMarker(markerPid: number): { claims: string; claim: string; marker: string } {
    const claims = join(dir, 'cache', 'outbox-claims')
    mkdirSync(claims, { recursive: true })
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    const claim = join(claims, `${ID}.json`)
    const raw = JSON.stringify({ key: 'k-stale', token: 't-stale', pid: deadPid, host: hostname(), at: Date.now() - 1_000, until: Date.now() + 59_000 })
    writeFileSync(claim, raw)
    const marker = `${claim}.takeover-${tag(raw)}`
    writeFileSync(marker, JSON.stringify({ token: 't-marker', pid: markerPid, host: hostname(), at: Date.now(), until: Date.now() + 60_000 }))
    return { claims, claim, marker }
  }

  it('a racer that died holding the takeover marker does not wedge the entry', () => {
    const deadRacer = spawnSync(process.execPath, ['-e', '']).pid
    const { claims, claim, marker } = staleClaimWithMarker(deadRacer)
    const plur = new Plur({ path: dir }) as any
    expect(plur._claimOutboxEntry(ID, () => 'k-new').status).toBe('claimed')
    expect(JSON.parse(readFileSync(claim, 'utf8')).pid).toBe(process.pid)
    // The dead marker is cleared once the claim has changed hands.
    expect(existsSync(marker)).toBe(false)
    expect(readdirSync(claims)).toEqual([`${ID}.json`])
    plur._releaseOutboxClaim(ID)
    expect(readdirSync(claims)).toEqual([])
  })

  it('a live racer holding the takeover marker keeps the entry: busy, nothing replaced', () => {
    const { claim, marker } = staleClaimWithMarker(process.pid)
    const before = readFileSync(claim, 'utf8')
    const plur = new Plur({ path: dir }) as any
    expect(plur._claimOutboxEntry(ID, () => 'k-new').status).toBe('busy')
    expect(readFileSync(claim, 'utf8')).toBe(before)
    expect(existsSync(marker)).toBe(true)
    rmSync(join(dir, 'cache', 'outbox-claims'), { recursive: true, force: true })
  })
})

describe('the duplicate bound on a key-ignoring server (#1463)', () => {
  // The review's scenario: three flushes each cut at their time budget after
  // the server stored the write, then one flush that completes. Claims and
  // the row re-read stop CONCURRENT duplicates; they cannot stop these, which
  // are sequential retries of a write whose earlier attempts landed unheard.
  // Only a key-honouring server collapses them.
  async function cutThenFlush(cuts: number): Promise<number> {
    await queue('bound: cut then flushed')
    const plur = new Plur({ path: dir })
    server.appendDelayMs = 10_000 // stored on receipt, answered too late
    for (let i = 0; i < cuts; i++) {
      const r = await plur.flushOutbox({ timeoutMs: 150 })
      // (A key-honouring server answers a replayed key at once, so there only
      // the first flush is cut.)
      if (!server.honourIdempotency) expect(r.deferred, `flush ${i + 1} was not cut`).toBe(1)
    }
    server.appendDelayMs = 0
    if (outboxRowCount() > 0) expect((await plur.flushOutbox({ timeoutMs: 10_000 })).flushed).toBe(1)
    expect(outboxRowCount()).toBe(0)
    return server.engramCount
  }

  it('each attempt that landed unheard leaves one more row: 3 cut flushes + 1 flush = 4 rows', async () => {
    expect(await cutThenFlush(3)).toBe(4)
    expect(server.appendCountFor('bound: cut then flushed')).toBe(4)
    expect(new Set(server.appendKeys.filter(Boolean)).size, 'every retry must reuse the one key').toBe(1)
  }, 60_000)

  it('the same scenario on a key-honouring server stores the write once', async () => {
    server.honourIdempotency = true
    expect(await cutThenFlush(3)).toBe(1)
  }, 60_000)
})
