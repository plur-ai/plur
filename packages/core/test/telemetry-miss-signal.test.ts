import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyMiss,
  emitMissSignal,
  fingerprintQuery,
  buildMissSignalPayload,
  DEFAULT_MISS_SCORE_THRESHOLD,
  type MissSignalOpts,
  type MissSignalInput,
} from '../src/telemetry-miss-signal.js'

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'plur-miss-'))
}

type CapturedPost = { body: any }
function captureFetch(ok = true) {
  const calls: CapturedPost[] = []
  const fakeFetch = (async (_url: string, init: any) => {
    calls.push({ body: init?.body ? JSON.parse(init.body as string) : null })
    return { ok } as Response
  }) as unknown as typeof globalThis.fetch
  return { calls, fakeFetch }
}

describe('telemetry miss-signal (WS5 demand flywheel)', () => {
  let dir: string
  let configPath: string
  let installIdPath: string

  beforeEach(() => {
    dir = newDir()
    configPath = join(dir, 'telemetry.json')
    installIdPath = join(dir, 'install-id')
  })

  function offOpts(extra: Partial<MissSignalOpts> = {}): MissSignalOpts {
    return { env: {}, configPath, installIdPath, ...extra }
  }
  function onOpts(extra: Partial<MissSignalOpts> = {}): MissSignalOpts {
    return { env: { PLUR_TELEMETRY: 'on' }, configPath, installIdPath, ...extra }
  }

  const hit: MissSignalInput = { query: 'q', resultCount: 5, topScore: 0.05 }
  const noResults: MissSignalInput = { query: 'q', resultCount: 0, topScore: null }
  const lowScore: MissSignalInput = { query: 'q', resultCount: 3, topScore: 0.001 }

  describe('classifyMiss (pure)', () => {
    it('returns null for a real hit (results + score above floor)', () => {
      expect(classifyMiss(hit)).toBeNull()
    })
    it('returns no_results for zero results', () => {
      expect(classifyMiss(noResults)).toBe('no_results')
    })
    it('returns no_results when topScore is null despite a count', () => {
      expect(classifyMiss({ resultCount: 2, topScore: null })).toBe('no_results')
    })
    it('returns low_score when top score is below the floor', () => {
      expect(classifyMiss(lowScore)).toBe('low_score')
    })
    it('respects a custom threshold', () => {
      expect(classifyMiss({ resultCount: 1, topScore: 0.02 }, 0.05)).toBe('low_score')
      expect(classifyMiss({ resultCount: 1, topScore: 0.02 }, 0.01)).toBeNull()
    })
  })

  describe('fingerprintQuery (privacy)', () => {
    it('is a 64-char hex SHA-256 digest, not the query', () => {
      const fp = fingerprintQuery('how do I deploy the trading bot')
      expect(fp).toMatch(/^[0-9a-f]{64}$/)
      expect(fp).not.toContain('deploy')
    })
    it('is stable across whitespace/case normalization', () => {
      expect(fingerprintQuery('Deploy  The  Bot')).toBe(fingerprintQuery('deploy the bot'))
    })
    it('differs for different queries', () => {
      expect(fingerprintQuery('alpha')).not.toBe(fingerprintQuery('beta'))
    })
  })

  describe('buildMissSignalPayload (wire shape)', () => {
    it('carries ONLY fingerprint + coarse labels + reason + count + date — never raw query', () => {
      const now = new Date('2026-06-14T10:00:00Z')
      const payload = buildMissSignalPayload(
        { query: 'secret query text', scope: 'project:x', domain: 'trading', resultCount: 0, topScore: null },
        'no_results',
        'install-abc',
        now,
      )
      expect(payload).toEqual({
        install_id: 'install-abc',
        query_fingerprint: fingerprintQuery('secret query text'),
        scope: 'project:x',
        domain: 'trading',
        reason: 'no_results',
        result_count: 0,
        date: '2026-06-14',
      })
      // No raw query anywhere in the serialized payload.
      expect(JSON.stringify(payload)).not.toContain('secret query text')
    })
    it('nulls absent scope/domain', () => {
      const payload = buildMissSignalPayload(noResults, 'no_results', 'id', new Date())
      expect(payload.scope).toBeNull()
      expect(payload.domain).toBeNull()
    })
  })

  describe('emitMissSignal gating', () => {
    it('default-off install makes zero network calls (a miss is still silent)', async () => {
      const { calls, fakeFetch } = captureFetch()
      const sent = await emitMissSignal(noResults, offOpts({ fetch: fakeFetch }))
      expect(sent).toBe(false)
      expect(calls).toHaveLength(0)
    })

    it('opted-out via PLUR_TELEMETRY=off makes zero network calls', async () => {
      const { calls, fakeFetch } = captureFetch()
      const sent = await emitMissSignal(noResults, { env: { PLUR_TELEMETRY: 'off' }, configPath, installIdPath, fetch: fakeFetch })
      expect(sent).toBe(false)
      expect(calls).toHaveLength(0)
    })

    it('opted-in + hit emits nothing (not a miss)', async () => {
      const { calls, fakeFetch } = captureFetch()
      const sent = await emitMissSignal(hit, onOpts({ fetch: fakeFetch }))
      expect(sent).toBe(false)
      expect(calls).toHaveLength(0)
    })

    it('opted-in + no-results emits exactly one content-free signal', async () => {
      const { calls, fakeFetch } = captureFetch()
      const sent = await emitMissSignal(
        { query: 'unanswerable', scope: 's', domain: 'd', resultCount: 0, topScore: null },
        onOpts({ fetch: fakeFetch }),
      )
      expect(sent).toBe(true)
      expect(calls).toHaveLength(1)
      const body = calls[0].body
      expect(body.reason).toBe('no_results')
      expect(body.query_fingerprint).toBe(fingerprintQuery('unanswerable'))
      expect(JSON.stringify(body)).not.toContain('unanswerable')
    })

    it('opted-in + low-score emits a low_score signal', async () => {
      const { calls, fakeFetch } = captureFetch()
      const sent = await emitMissSignal(lowScore, onOpts({ fetch: fakeFetch }))
      expect(sent).toBe(true)
      expect(calls[0].body.reason).toBe('low_score')
    })

    it('respects PLUR_MISS_SCORE_THRESHOLD override', async () => {
      const { calls, fakeFetch } = captureFetch()
      // score 0.02 is a hit at default floor (0.015) but a miss at 0.05.
      const input: MissSignalInput = { query: 'q', resultCount: 1, topScore: 0.02 }
      await emitMissSignal(input, onOpts({ fetch: fakeFetch, env: { PLUR_TELEMETRY: 'on', PLUR_MISS_SCORE_THRESHOLD: '0.05' } }))
      expect(calls).toHaveLength(1)
      expect(calls[0].body.reason).toBe('low_score')
    })

    it('never throws on transport failure — resolves false', async () => {
      const throwingFetch = (async () => {
        throw new Error('network down')
      }) as unknown as typeof globalThis.fetch
      const sent = await emitMissSignal(noResults, onOpts({ fetch: throwingFetch }))
      expect(sent).toBe(false)
    })

    it('returns false when endpoint responds non-2xx', async () => {
      const { fakeFetch } = captureFetch(false)
      const sent = await emitMissSignal(noResults, onOpts({ fetch: fakeFetch }))
      expect(sent).toBe(false)
    })
  })

  it('DEFAULT_MISS_SCORE_THRESHOLD sits just under a single top-1 RRF hit (~0.0164)', () => {
    expect(DEFAULT_MISS_SCORE_THRESHOLD).toBeLessThan(1 / 61)
    expect(DEFAULT_MISS_SCORE_THRESHOLD).toBeGreaterThan(0)
  })
})
