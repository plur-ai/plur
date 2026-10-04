// Formal verification round 2, core-retrieval#7 (spec/formal/findings/r2-retrieval.md §1).
//
// Invariant (PlurSpec.R2Retrieval.Telemetry): for every date, the counts shipped
// plus the counts still on disk (counters.json, pending/, in-flight claims) equal
// the events recorded. The pre-fix code broke it four ways, each replayed here:
//   1. two recorders read the same stale snapshot → yesterday merged into pending twice;
//   2. two recorders read the same same-day snapshot → one increment lost;
//   3. two concurrent flushes read the same pending file → the same day POSTed twice;
//   4. a merge into pending while a POST is in flight → the merged counts deleted unsent.
//
// The interleavings are forced through the code's own filesystem seam (a pass-through
// node:fs mock that can run a second call in the middle of the first one's read) and,
// for (2), through real child processes. The POST goes to an in-process stub.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let readHook: { path: string; run: () => void } | null = null

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (path: any, ...rest: any[]) => {
      const out = (actual.readFileSync as any)(path, ...rest)
      if (readHook && String(path) === readHook.path) {
        const h = readHook
        readHook = null
        h.run() // the second caller runs to completion between our read and our write
      }
      return out
    },
  }
})

const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
const { recordEvent, readPendingCounters, listPendingDates, settleSpilledEvents } = await import('../src/telemetry-counters.js')
const { flushIfNeeded } = await import('../src/telemetry-flush.js')

const D = '2026-05-10'
const dayD = () => new Date('2026-05-10T18:00:00Z')
const dayD1 = () => new Date('2026-05-11T00:30:00Z')

describe('formal R2 core-retrieval#7 — telemetry counters conserve events', () => {
  let dir: string
  let base: Record<string, any>

  beforeEach(() => {
    readHook = null
    dir = fs.mkdtempSync(join(tmpdir(), 'plur-r2-telemetry-'))
    base = {
      env: { PLUR_TELEMETRY: 'on' },
      configPath: join(dir, 'telemetry.json'),
      countersPath: join(dir, 'counters.json'),
      installIdPath: join(dir, 'install-id'),
      pendingDir: join(dir, 'pending'),
    }
  })

  function readCounters() {
    return JSON.parse(fs.readFileSync(base.countersPath, 'utf8'))
  }

  it('(1) a second recorder crossing midnight in the middle of the first does not double-count yesterday', () => {
    fs.writeFileSync(base.countersPath, JSON.stringify({ date: D, learn: 3, recall: 0, session: 1 }))
    readHook = { path: base.countersPath, run: () => { recordEvent('learn', { ...base, now: dayD1 }) } }
    recordEvent('learn', { ...base, now: dayD1 })
    // Recorded for D: 3. Pre-fix: pending D = 6 (both callers merged the same snapshot).
    expect(readPendingCounters(D, base)?.learn).toBe(3)
  })

  it('(2) concurrent recorders in separate processes lose no increment and double-count nothing', async () => {
    fs.writeFileSync(base.countersPath, JSON.stringify({ date: D, learn: 5, recall: 0, session: 1 }))
    const srcPath = resolve(__dirname, '../src/telemetry-counters.ts')
    const go = join(dir, 'go')
    const script = join(dir, 'child.mts')
    fs.writeFileSync(script, `
      import { existsSync } from 'node:fs'
      const { recordEvent } = await import(${JSON.stringify(srcPath)})
      const opts = JSON.parse(process.argv[2])
      while (!existsSync(${JSON.stringify(go)})) {}
      for (let i = 0; i < 40; i++) recordEvent('learn', { ...opts, now: () => new Date('2026-05-11T00:30:00Z') })
    `)
    const N = 4
    const children = Array.from({ length: N }, () =>
      spawn(process.execPath, ['--import', 'tsx', script, JSON.stringify(base)], {
        cwd: resolve(__dirname, '..'),
        stdio: ['ignore', 'ignore', 'pipe'],
      }),
    )
    const done = children.map((c) => new Promise<number>((res) => {
      let err = ''
      c.stderr!.on('data', (b) => (err += b))
      c.on('exit', (code) => { if (code !== 0) console.error(err); res(code ?? 1) })
    }))
    await new Promise((r) => setTimeout(r, 1500)) // let every child reach the barrier
    fs.writeFileSync(go, '')
    expect(await Promise.all(done)).toEqual(Array(N).fill(0))
    // A recorder that could not take the lock spilled its event instead of
    // dropping it (gap closure 2026-09-27); fold the spill before counting.
    settleSpilledEvents({ ...base, now: dayD1 })
    expect(readPendingCounters(D, base)?.learn).toBe(5)
    expect(readCounters().learn).toBe(N * 40)
  }, 60_000)

  it('(3) two concurrent flushes POST a pending day once', async () => {
    recordEvent('learn', { ...base, now: dayD })
    recordEvent('learn', { ...base, now: dayD1 }) // rollover → pending D
    const posts: any[] = []
    const fetch = (async (_u: string, init: any) => {
      posts.push(JSON.parse(init.body))
      await new Promise((r) => setTimeout(r, 20))
      return { ok: true } as Response
    }) as unknown as typeof globalThis.fetch
    await Promise.all([
      flushIfNeeded({ ...base, fetch, now: dayD1, packageVersion: 't' }),
      flushIfNeeded({ ...base, fetch, now: dayD1, packageVersion: 't' }),
    ])
    expect(posts.filter((p) => p.date === D).map((p) => p.learn_count)).toEqual([1])
    expect(listPendingDates(base)).toEqual([])
  })

  it('(4) counts merged into a pending day while its POST is in flight are shipped later, not deleted', async () => {
    fs.mkdirSync(base.pendingDir, { recursive: true })
    fs.writeFileSync(join(base.pendingDir, `${D}.json`), JSON.stringify({ date: D, learn: 3, recall: 0, session: 1 }))
    fs.writeFileSync(base.countersPath, JSON.stringify({ date: '2026-05-11', learn: 0, recall: 0, session: 0 }))
    const shipped: number[] = []
    let first = true
    const fetch = (async (_u: string, init: any) => {
      const body = JSON.parse(init.body)
      if (body.date === D) shipped.push(body.learn_count)
      if (first) {
        first = false
        // While the POST is in flight, another snapshot for D (2 more learns) reaches pending.
        fs.writeFileSync(base.countersPath, JSON.stringify({ date: D, learn: 2, recall: 0, session: 1 }))
        recordEvent('recall', { ...base, now: dayD1 })
      }
      return { ok: true } as Response
    }) as unknown as typeof globalThis.fetch
    await flushIfNeeded({ ...base, fetch, now: dayD1, packageVersion: 't' })
    await flushIfNeeded({ ...base, fetch, now: dayD1, packageVersion: 't' })
    // Recorded for D: 3 + 2. Pre-fix: 3 shipped, the 2 deleted with the file.
    expect(shipped.reduce((a, b) => a + b, 0)).toBe(5)
  })

  it('(5) a claim left by a crashed flusher is shipped by the next flush (at-least-once, as before)', async () => {
    fs.mkdirSync(base.pendingDir, { recursive: true })
    const dead = 2 ** 22 + 12345 // above pid_max on macOS and default Linux
    fs.writeFileSync(
      join(base.pendingDir, `${D}.json.sending.${encodeURIComponent(hostname())}.${dead}.00000000-0000-4000-8000-000000000000`),
      JSON.stringify({ date: D, learn: 7, recall: 1, session: 1 }),
    )
    fs.writeFileSync(base.countersPath, JSON.stringify({ date: '2026-05-11', learn: 0, recall: 0, session: 0 }))
    const posts: any[] = []
    const fetch = (async (_u: string, init: any) => { posts.push(JSON.parse(init.body)); return { ok: true } as Response }) as unknown as typeof globalThis.fetch
    await flushIfNeeded({ ...base, fetch, now: dayD1, packageVersion: 't' })
    expect(posts.map((p) => [p.date, p.learn_count])).toEqual([[D, 7]])
    expect(fs.readdirSync(base.pendingDir)).toEqual([])
  })

  it('a failed POST puts the claim back for the next flush', async () => {
    recordEvent('learn', { ...base, now: dayD })
    recordEvent('learn', { ...base, now: dayD1 })
    let ok = false
    const posts: any[] = []
    const fetch = (async (_u: string, init: any) => { posts.push(JSON.parse(init.body)); return { ok } as Response }) as unknown as typeof globalThis.fetch
    await flushIfNeeded({ ...base, fetch, now: dayD1, packageVersion: 't' })
    expect(listPendingDates(base)).toEqual([D])
    expect(fs.readdirSync(base.pendingDir)).toEqual([`${D}.json`])
    ok = true
    await flushIfNeeded({ ...base, fetch, now: dayD1, packageVersion: 't' })
    expect(posts.map((p) => p.learn_count)).toEqual([1, 1])
    expect(fs.readdirSync(base.pendingDir)).toEqual([])
  })
})
