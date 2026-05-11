import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildHeartbeatPayload,
  flushIfNeeded,
  type FlushOpts,
} from '../src/telemetry-flush.js'
import type { CounterSnapshot } from '../src/telemetry-counters.js'

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'plur-flush-'))
}

describe('telemetry flush (#51 slice D-2b)', () => {
  let dir: string
  let countersPath: string
  let installIdPath: string
  let configPath: string

  beforeEach(() => {
    dir = newDir()
    countersPath = join(dir, 'counters.json')
    installIdPath = join(dir, 'install-id')
    configPath = join(dir, 'telemetry.json')
  })

  function offOpts(extra: Partial<FlushOpts> = {}): FlushOpts {
    return { env: {}, configPath, countersPath, installIdPath, ...extra }
  }

  function onOpts(extra: Partial<FlushOpts> = {}): FlushOpts {
    return {
      env: { PLUR_TELEMETRY: 'on' },
      configPath,
      countersPath,
      installIdPath,
      ...extra,
    }
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
})
