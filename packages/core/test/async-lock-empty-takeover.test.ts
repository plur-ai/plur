/**
 * #1354: an EMPTY store lock left by a killed process must not block every
 * writer for the full 60s stale threshold.
 *
 * The lock used to be taken in two steps — an O_EXCL create of
 * `engrams.yaml.lock`, then a write of the owner token. A process killed between
 * them left an empty file no one could attribute, so the liveness check (which
 * reads the pid out of the token) had nothing to go on and every later writer
 * waited out the stale threshold.
 *
 * Two changes, both pinned here:
 *   - core now publishes the lock COMPLETE (token written to a private file,
 *     then hard-linked into place), so its own acquisitions never expose an
 *     empty lock at all;
 *   - an empty lock older than EMPTY_LOCK_GRACE_MS — left by an older client, a
 *     filesystem without hard links, or anything else that creates first and
 *     writes second — is taken over, through the same single-winner rename
 *     claim as every other steal.
 *
 * And one thing that must NOT change: a lock carrying a live owner's token is
 * never taken early, however old it is.
 *
 * Every test runs in its own temp directory; nothing touches ~/.plur.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync,
  utimesSync, openSync, closeSync, readdirSync,
} from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { tmpdir, hostname } from 'os'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import {
  withAsyncLock, makeToken, DEFAULT_STALE_THRESHOLD, EMPTY_LOCK_GRACE_MS,
} from '../src/store/async-lock.js'
import { withLock } from '../src/sync.js'

const SRC = join(__dirname, '..', 'src')
// Worker processes import core's TypeScript SOURCE through tsx (a core
// devDependency; works on every Node in the CI matrix), so they run the code
// under test rather than a possibly stale dist/.
const TSX = pathToFileURL(createRequire(__filename).resolve('tsx')).href

let dir: string
let filePath: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-empty-lock-'))
  filePath = join(dir, 'engrams.yaml')
  lockPath = filePath + '.lock'
  writeFileSync(filePath, '')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** Create an empty lock, as a creator killed before its token write leaves it. */
function plantEmptyLock(ageMs: number): void {
  closeSync(openSync(lockPath, 'wx'))
  const t = new Date(Date.now() - ageMs)
  utimesSync(lockPath, t, t)
}

function waitForLine(child: ChildProcess, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = ''
    child.stdout!.on('data', d => { buf += d; if (buf.includes(line)) resolve() })
    child.on('exit', code => reject(new Error(`child exited (${code}) before "${line}": ${buf}`)))
  })
}

describe('empty store lock takeover (#1354)', () => {
  it('the grace period is well above the measured create→token-write gap and well below the stale threshold', () => {
    // Measured (20,000 acquisitions, idle loop): p99 10–20ms, max 0.7s; with a
    // loop busy in 20ms synchronous bursts: p99 117ms, max 0.7s. 10s is a
    // >10x margin on the worst observed gap, and still 6x faster than 60s.
    expect(EMPTY_LOCK_GRACE_MS).toBeGreaterThanOrEqual(5_000)
    expect(EMPTY_LOCK_GRACE_MS).toBeLessThanOrEqual(DEFAULT_STALE_THRESHOLD / 4)
  })

  it('a process SIGKILLed between the exclusive create and the token write does not block the next writer for the stale window', async () => {
    // The child does exactly the first half of the old acquisition — the
    // O_EXCL create — and is killed before it can write a token.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { openSync } from 'node:fs'
      openSync(${JSON.stringify(lockPath)}, 'wx')
      process.stdout.write('created\\n')
      setInterval(() => {}, 1000)
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    await waitForLine(child, 'created')
    const exited = new Promise(r => child.on('exit', r))
    child.kill('SIGKILL')
    await exited
    expect(readFileSync(lockPath, 'utf8')).toBe('')

    const started = Date.now()
    const result = await withAsyncLock(filePath, async () => 'acquired')
    const waited = Date.now() - started
    expect(result).toBe('acquired')
    // Taken over once the grace period has passed — not after 60s.
    expect(waited).toBeLessThan(EMPTY_LOCK_GRACE_MS + 5_000)
    expect(waited).toBeLessThan(DEFAULT_STALE_THRESHOLD / 2)
    expect(existsSync(lockPath)).toBe(false)
  }, 40_000)

  it('an empty lock older than the grace period is taken over at once', async () => {
    plantEmptyLock(EMPTY_LOCK_GRACE_MS + 1_000)
    const started = Date.now()
    expect(await withAsyncLock(filePath, async () => 'ok', { baseDelay: 20 })).toBe('ok')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(existsSync(lockPath)).toBe(false)
    // The takeover's claim file is cleaned up.
    expect(readdirSync(dir).filter(f => f.includes('.steal.'))).toEqual([])
  }, 10_000)

  it('the sync lock takes over an old empty lock too', () => {
    plantEmptyLock(EMPTY_LOCK_GRACE_MS + 1_000)
    expect(withLock(filePath, () => 'ok', { baseDelay: 5 })).toBe('ok')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('a FRESH empty lock is waited for — its creator may be about to write the token', async () => {
    plantEmptyLock(0)
    let ran = false
    const pending = withAsyncLock(filePath, async () => { ran = true; return 'ok' }, { baseDelay: 20 })
    await new Promise(r => setTimeout(r, 800))
    expect(ran).toBe(false)
    // The creator finishes and releases: the waiter gets it normally.
    unlinkSync(lockPath)
    expect(await pending).toBe('ok')
  })

  it('an old lock with a LIVE owner token is never taken early, however old it is', async () => {
    // Our own pid: liveness says alive. Backdated past both the grace period
    // and the stale threshold — neither may trigger a steal from a live owner.
    const token = makeToken()
    writeFileSync(lockPath, token)
    const past = new Date(Date.now() - DEFAULT_STALE_THRESHOLD - 60_000)
    utimesSync(lockPath, past, past)

    let ran = false
    const pending = withAsyncLock(filePath, async () => { ran = true }, { baseDelay: 20 })
    await new Promise(r => setTimeout(r, 800))
    expect(ran).toBe(false)
    expect(readFileSync(lockPath, 'utf8')).toBe(token)
    unlinkSync(lockPath)
    await pending
    expect(ran).toBe(true)
  })

  it('a non-empty lock we cannot probe keeps the full stale threshold — the grace period is for EMPTY locks only', async () => {
    writeFileSync(lockPath, `some-other-machine:4242:${Date.now()}:0`)
    const t = new Date(Date.now() - EMPTY_LOCK_GRACE_MS - 5_000)
    utimesSync(lockPath, t, t)

    let ran = false
    const pending = withAsyncLock(filePath, async () => { ran = true }, { baseDelay: 20 })
    await new Promise(r => setTimeout(r, 800))
    expect(ran).toBe(false)
    unlinkSync(lockPath)
    await pending
  })

  it('core never exposes an empty lock while acquiring', async () => {
    // An observer in another process reads the lock file as fast as it can
    // while this process acquires and releases it thousands of times. With the
    // old create-then-write acquisition it catches empty files; with the lock
    // published complete, every read is either ENOENT or a full token.
    const observer = spawn(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync, existsSync } from 'node:fs'
      const lock = ${JSON.stringify(lockPath)}, stop = ${JSON.stringify(join(dir, 'stop'))}
      let empty = 0, full = 0, i = 0
      process.stdout.write('ready\\n')
      while (true) {
        if ((++i & 1023) === 0 && existsSync(stop)) break
        try { readFileSync(lock, 'utf8') === '' ? empty++ : full++ } catch {}
      }
      process.stdout.write(JSON.stringify({ empty, full }) + '\\n')
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    observer.stdout!.on('data', d => { out += d })
    await waitForLine(observer, 'ready')

    for (let i = 0; i < 3_000; i++) await withAsyncLock(filePath, async () => {})
    writeFileSync(join(dir, 'stop'), '')
    await new Promise(r => observer.on('exit', r))
    const counts = JSON.parse(out.trim().split('\n').pop()!)
    expect(counts.full).toBeGreaterThan(0) // the observer did see the lock held
    expect(counts.empty).toBe(0)
    // No private publish files left behind.
    expect(readdirSync(dir).filter(f => f !== 'engrams.yaml' && f !== 'stop')).toEqual([])
  }, 60_000)

  it('concurrent acquirers in separate processes racing to take over abandoned empty locks never hold it together', async () => {
    // Each worker process loops: acquire (async or sync flavour), prove it is
    // alone by creating a marker with O_EXCL, hold briefly, release. Meanwhile
    // this process keeps planting abandoned empty locks whenever the lock is
    // free, so the workers are constantly racing each other to take one over.
    const marker = join(dir, 'inside')
    const log = join(dir, 'log')
    const worker = (flavour: 'async' | 'sync', rounds: number) => `
      import { openSync, closeSync, unlinkSync, appendFileSync } from 'node:fs'
      import { withAsyncLock } from ${JSON.stringify(join(SRC, 'store', 'async-lock.ts'))}
      import { withLock } from ${JSON.stringify(join(SRC, 'sync.ts'))}
      const file = ${JSON.stringify(filePath)}, marker = ${JSON.stringify(marker)}, log = ${JSON.stringify(log)}
      const spin = ms => { const e = Date.now() + ms; while (Date.now() < e) {} }
      const body = () => {
        try { closeSync(openSync(marker, 'wx')) } catch { appendFileSync(log, 'OVERLAP\\n'); return }
        spin(3)
        unlinkSync(marker)
        appendFileSync(log, 'ok\\n')
      }
      for (let i = 0; i < ${rounds}; i++) {
        ${flavour === 'async'
          ? 'await withAsyncLock(file, async () => body(), { baseDelay: 2 })'
          // The sync lock's retry budget is short by design (it busy-waits);
          // running out under this much contention is a loud, safe failure,
          // not what this test is about — so try again.
          : `for (;;) {
              try { withLock(file, body, { baseDelay: 2, maxRetries: 10 }); break }
              catch (e) { if (!/Failed to acquire lock/.test(e.message)) throw e }
            }`}
      }
    `
    const ROUNDS = 30
    const flavours: Array<'async' | 'sync'> = ['async', 'async', 'async', 'sync', 'sync']
    const children = flavours.map(f => spawn(process.execPath,
      ['--import', TSX, '--input-type=module', '-e', worker(f, ROUNDS)],
      { stdio: ['ignore', 'inherit', 'inherit'] }))
    const exits = children.map(c => new Promise<number | null>(r => c.on('exit', r)))

    let planted = 0
    let done = false
    void Promise.all(exits).then(() => { done = true })
    while (!done) {
      try { plantEmptyLock(EMPTY_LOCK_GRACE_MS + 60_000); planted++ } catch { /* held — fine */ }
      await new Promise(r => setTimeout(r, 3))
    }
    const codes = await Promise.all(exits)

    const lines = readFileSync(log, 'utf8').trim().split('\n')
    // Checked first: two holders at once is the failure this test exists for.
    // This is a soak test; the specific interleavings are pinned
    // deterministically by the paused-takeover test below.
    expect(lines.filter(l => l === 'OVERLAP')).toEqual([])
    expect(codes).toEqual(flavours.map(() => 0))
    expect(lines.length).toBe(flavours.length * ROUNDS)
    expect(planted).toBeGreaterThan(0) // the takeover path was actually raced
    // A takeover leaves no claim or publish files behind.
    const litter = readdirSync(dir).filter(f => f.includes('.steal.') || f.endsWith('.tmp'))
    expect(litter).toEqual([])
  }, 120_000)

  it.each([
    ['an old empty lock', () => plantEmptyLock(EMPTY_LOCK_GRACE_MS + 60_000)],
    // The guard covers every takeover, including the dead-holder one that has
    // always been immediate — the race is not specific to empty locks.
    ['a dead holder\'s lock', () => writeFileSync(lockPath, `${hostname()}:2147483646:${Date.now()}:0`)],
  ])('two waiters that judged the same abandoned lock cannot both end up holding it — %s (deterministic)', async (_kind, plant) => {
    // The race the takeover guard exists for, made deterministic by pausing a
    // taker (helpers/pause-lock-steal.mjs). Without the guard it goes:
    //   T judges the abandoned lock and pauses just before its claim rename;
    //   U judges the same lock, takes it over and ACQUIRES;
    //   T resumes and renames U's live lock aside, sees the wrong file and
    //     pauses just before putting it back;
    //   V finds the path free and acquires — while U is still inside.
    // With the guard, U cannot take over while T is mid-takeover, so T's
    // claim removes the lock it actually judged and the others wait their turn.
    const marker = join(dir, 'inside')
    const log = join(dir, 'log')
    const at = (f: string) => join(dir, f)
    const waitFor = async (f: string, ms: number): Promise<boolean> => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (existsSync(at(f))) return true
        await new Promise(r => setTimeout(r, 10))
      }
      return false
    }
    const holder = (name: string, pause: boolean) => spawn(process.execPath, [
      '--import', TSX,
      ...(pause ? ['--import', join(__dirname, 'helpers', 'pause-lock-steal.mjs')] : []),
      '--input-type=module', '-e', `
        import { openSync, closeSync, unlinkSync, appendFileSync, existsSync, writeFileSync } from 'node:fs'
        import { withAsyncLock } from ${JSON.stringify(join(SRC, 'store', 'async-lock.ts'))}
        const at = f => ${JSON.stringify(dir)} + '/' + f
        const until = async f => { while (!existsSync(at(f))) await new Promise(r => setTimeout(r, 10)) }
        await withAsyncLock(${JSON.stringify(filePath)}, async () => {
          let mine = true
          try { closeSync(openSync(${JSON.stringify(marker)}, 'wx')) }
          catch { mine = false; appendFileSync(${JSON.stringify(log)}, 'OVERLAP ${name}\\n') }
          writeFileSync(at('holding-${name}'), '')
          await until('release-${name}')
          if (mine) unlinkSync(${JSON.stringify(marker)})
        }, { baseDelay: 20 })
      `], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PLUR_TEST_PAUSE_DIR: dir } })
    const exited = (c: ChildProcess) => new Promise<number | null>(r => c.on('exit', r))
    const releaseAll = () => { for (const n of ['T', 'U', 'V']) writeFileSync(at(`release-${n}`), '') }

    plant()
    const T = holder('T', true)
    const exits = [exited(T)]
    try {
      expect(await waitFor('paused-rename', 20_000)).toBe(true)

      const U = holder('U', false)
      exits.push(exited(U))
      await waitFor('holding-U', 2_000) // happens only without the guard

      writeFileSync(at('go-rename'), '')
      // Either T took over the lock it judged (guarded), or it moved U's live
      // lock aside and is about to put it back (unguarded).
      const end = Date.now() + 10_000
      while (Date.now() < end && !existsSync(at('holding-T')) && !existsSync(at('paused-link'))) {
        await new Promise(r => setTimeout(r, 10))
      }
      if (existsSync(at('paused-link'))) {
        const V = holder('V', false)
        exits.push(exited(V))
        await waitFor('holding-V', 5_000)
        writeFileSync(at('go-link'), '')
      }
    } finally {
      releaseAll()
      writeFileSync(at('go-rename'), '')
      writeFileSync(at('go-link'), '')
    }
    const codes = await Promise.all(exits)

    const overlaps = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    expect(overlaps).toEqual([])
    expect(codes.every(c => c === 0)).toBe(true)
    expect(existsSync(at('holding-T'))).toBe(true) // T really took the lock over
  }, 60_000)
})
