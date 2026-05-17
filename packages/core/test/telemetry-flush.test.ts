import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildHeartbeatPayload,
  flushIfNeeded,
  type FlushOpts,
} from '../src/telemetry-flush.js'
import {
  listPendingDates,
  recordEvent,
  type CounterSnapshot,
} from '../src/telemetry-counters.js'

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'plur-flush-'))
}

describe('telemetry flush (#51 slice D-2b)', () => {
  let dir: string
  let countersPath: string
  let installIdPath: string
  let pendingDir: string
  let configPath: string

  beforeEach(() => {
    dir = newDir()
    countersPath = join(dir, 'counters.json')
    installIdPath = join(dir, 'install-id')
    pendingDir = join(dir, 'pending')
    configPath = join(dir, 'telemetry.json')
  })

  function offOpts(extra: Partial<FlushOpts> = {}): FlushOpts {
    return { env: {}, configPath, countersPath, installIdPath, pendingDir, ...extra }
  }

  function onOpts(extra: Partial<FlushOpts> = {}): FlushOpts {
    return {
      env: { PLUR_TELEMETRY: 'on' },
      configPath,
      countersPath,
      installIdPath,
      pendingDir,
      ...extra,
    }
  }

  type CapturedPost = { body: any; ok: boolean }
  function captureFetch(initial: { ok: boolean } = { ok: true }) {
    const calls: CapturedPost[] = []
    let nextOk = initial.ok
    const fakeFetch = (async (_url: string, init: any) => {
      const parsed = init?.body ? JSON.parse(init.body as string) : null
      calls.push({ body: parsed, ok: nextOk })
      return { ok: nextOk } as Response
    }) as unknown as typeof globalThis.fetch
    return { calls, fakeFetch, setNextOk: (v: boolean) => (nextOk = v) }
  }

  it('default-off install makes zero network calls (invariant 1)', async () => {
    let fetchCalls = 0
    const fakeFetch = (async () => {
      fetchCalls++
      throw new Error('should never run')
    }) as unknown as typeof globalThis.fetch

    // Pre-stage a stale counter file so the gate is the only thing protecting us.
    writeFileSync(
      countersPath,
      JSON.stringify({ date: '2026-05-01', learn: 5, recall: 10, session: 3 }),
    )

    await flushIfNeeded(offOpts({ fetch: fakeFetch, now: () => new Date('2026-05-11T00:00:00Z') }))
    expect(fetchCalls).toBe(0)
  })

  it('telemetry-on but no counter file → zero network calls (invariant 2)', async () => {
    let fetchCalls = 0
    const fakeFetch = (async () => {
      fetchCalls++
      throw new Error('should never run')
    }) as unknown as typeof globalThis.fetch

    await flushIfNeeded(onOpts({ fetch: fakeFetch, now: () => new Date('2026-05-11T00:00:00Z') }))
    expect(fetchCalls).toBe(0)
  })

  it('buildHeartbeatPayload produces the exact contract shape', () => {
    const snapshot: CounterSnapshot = {
      installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      date: '2026-05-10',
      learn: 7,
      recall: 23,
      session: 2,
    }
    const payload = buildHeartbeatPayload(snapshot, { packageVersion: '0.9.14' })
    expect(payload).toEqual({
      install_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      version: '0.9.14',
      platform: process.platform,
      date: '2026-05-10',
      learn_count: 7,
      recall_count: 23,
      session_count: 2,
    })
    // Locked contract: no extra keys (server rejects them).
    expect(Object.keys(payload).sort()).toEqual([
      'date',
      'install_id',
      'learn_count',
      'platform',
      'recall_count',
      'session_count',
      'version',
    ])
  })

  // -----------------------------------------------------------------------
  // #128 acceptance: day-rollover flush race
  // -----------------------------------------------------------------------

  it('long-lived process across midnight: yesterday posted, not discarded (#128)', async () => {
    const { calls, fakeFetch } = captureFetch()

    // Day Y: emit events.
    const dayY = () => new Date('2026-05-10T18:00:00Z')
    recordEvent('learn', onOpts({ now: dayY }))
    recordEvent('recall', onOpts({ now: dayY }))
    recordEvent('recall', onOpts({ now: dayY }))

    // Sanity: counters.json holds day Y data.
    expect(JSON.parse(readFileSync(countersPath, 'utf8'))).toEqual({
      date: '2026-05-10',
      learn: 1,
      recall: 2,
      session: 1,
    })

    // Cross midnight: emit event on day Y+1. Yesterday's snapshot moves to pending.
    const dayY1 = () => new Date('2026-05-11T00:30:00Z')
    const rolled = recordEvent('learn', onOpts({ now: dayY1 }))
    expect(rolled).toBe(true)
    expect(listPendingDates({ pendingDir })).toEqual(['2026-05-10'])

    // Flush fires; yesterday gets POSTed.
    await flushIfNeeded(onOpts({ fetch: fakeFetch, now: dayY1 }))

    expect(calls).toHaveLength(1)
    expect(calls[0].body.date).toBe('2026-05-10')
    expect(calls[0].body.learn_count).toBe(1)
    expect(calls[0].body.recall_count).toBe(2)
    expect(calls[0].body.session_count).toBe(1)

    // Pending file is cleaned up after successful flush.
    expect(listPendingDates({ pendingDir })).toEqual([])
    // Today's counters intact (the learn that crossed midnight).
    expect(JSON.parse(readFileSync(countersPath, 'utf8'))).toEqual({
      date: '2026-05-11',
      learn: 1,
      recall: 0,
      session: 1,
    })
  })

  it('beforeExit on process that crossed midnight without re-recording posts yesterday (#128)', async () => {
    const { calls, fakeFetch } = captureFetch()

    // Day Y: emit events.
    const dayY = () => new Date('2026-05-10T18:00:00Z')
    recordEvent('learn', onOpts({ now: dayY }))
    recordEvent('learn', onOpts({ now: dayY }))

    // Day Y+1: NO new recordEvent — beforeExit fires while counters.json
    // still has yesterday's date.
    const dayY1 = () => new Date('2026-05-11T03:00:00Z')
    await flushIfNeeded(onOpts({ fetch: fakeFetch, now: dayY1 }))

    expect(calls).toHaveLength(1)
    expect(calls[0].body.date).toBe('2026-05-10')
    expect(calls[0].body.learn_count).toBe(2)

    // After migration, counters.json is empty-today, pending drained.
    expect(listPendingDates({ pendingDir })).toEqual([])
    expect(JSON.parse(readFileSync(countersPath, 'utf8'))).toEqual({
      date: '2026-05-11',
      learn: 0,
      recall: 0,
      session: 0,
    })
  })

  it('process killed before midnight: next-startup flush drains pending (#128)', async () => {
    // Day Y old process: emits events, gets killed (no beforeExit, no flush).
    const dayY = () => new Date('2026-05-10T22:00:00Z')
    recordEvent('learn', onOpts({ now: dayY }))
    recordEvent('recall', onOpts({ now: dayY }))

    // Day Y+1 new process starts, records an event (triggers rollover to pending).
    const dayY1 = () => new Date('2026-05-11T08:00:00Z')
    recordEvent('recall', onOpts({ now: dayY1 }))
    expect(listPendingDates({ pendingDir })).toEqual(['2026-05-10'])

    // Startup flush.
    const { calls, fakeFetch } = captureFetch()
    await flushIfNeeded(onOpts({ fetch: fakeFetch, now: dayY1 }))
    expect(calls).toHaveLength(1)
    expect(calls[0].body.date).toBe('2026-05-10')
    expect(listPendingDates({ pendingDir })).toEqual([])
  })

  it('flush failure leaves pending file on disk for retry (#128)', async () => {
    const { calls, fakeFetch, setNextOk } = captureFetch({ ok: false })

    const dayY = () => new Date('2026-05-10T18:00:00Z')
    recordEvent('learn', onOpts({ now: dayY }))

    const dayY1 = () => new Date('2026-05-11T00:30:00Z')
    recordEvent('learn', onOpts({ now: dayY1 }))

    // First flush: server says no.
    await flushIfNeeded(onOpts({ fetch: fakeFetch, now: dayY1 }))
    expect(calls).toHaveLength(1)
    expect(calls[0].body.date).toBe('2026-05-10')
    expect(listPendingDates({ pendingDir })).toEqual(['2026-05-10']) // still there

    // Server recovers. Retry: pending drains.
    setNextOk(true)
    await flushIfNeeded(onOpts({ fetch: fakeFetch, now: dayY1 }))
    expect(calls).toHaveLength(2)
    expect(calls[1].body.date).toBe('2026-05-10')
    expect(listPendingDates({ pendingDir })).toEqual([])
  })

  it('multi-day gap: flush posts each pending date separately (#128)', async () => {
    const { calls, fakeFetch } = captureFetch()

    // Day Y: emit events
    recordEvent('learn', onOpts({ now: () => new Date('2026-05-09T12:00:00Z') }))
    // Day Y+1: rollover → pending(2026-05-09), record on Y+1
    recordEvent('learn', onOpts({ now: () => new Date('2026-05-10T12:00:00Z') }))
    // Day Y+2: rollover → pending(2026-05-10), record on Y+2
    recordEvent('learn', onOpts({ now: () => new Date('2026-05-11T12:00:00Z') }))

    expect(listPendingDates({ pendingDir })).toEqual(['2026-05-09', '2026-05-10'])

    await flushIfNeeded(
      onOpts({ fetch: fakeFetch, now: () => new Date('2026-05-11T12:30:00Z') }),
    )

    expect(calls.map((c) => c.body.date).sort()).toEqual(['2026-05-09', '2026-05-10'])
    expect(listPendingDates({ pendingDir })).toEqual([])
  })

  it('flush no-op when no pending and counters.json is for today', async () => {
    let fetchCalls = 0
    const fakeFetch = (async () => {
      fetchCalls++
      return { ok: true } as Response
    }) as unknown as typeof globalThis.fetch

    const today = () => new Date('2026-05-11T12:00:00Z')
    recordEvent('learn', onOpts({ now: today }))

    await flushIfNeeded(onOpts({ fetch: fakeFetch, now: today }))
    expect(fetchCalls).toBe(0)
  })
})
