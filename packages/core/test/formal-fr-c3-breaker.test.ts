/**
 * Formal cluster 3 (field report 2026-09-29) — the per-host breaker and
 * refusal statuses. Model: spec/formal/PlurSpec/Outbox.lean §Breaker.
 *
 * The write leg (#1308) never counts a 401/403/404/422; that is pinned by
 * outbox-breaker-refusal.test.ts. The recall leg feeds the SAME persisted
 * breaker (remote-health.json, #785), and there a 422 goes through the generic
 * `!res.ok` branch and counts. Temp state file, mocked fetch only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { remoteRecall, isHostInCooldown, BREAKER_FAILURE_THRESHOLD } from '../src/remote-recall.js'

const URL_ = 'https://store.example.test'

describe('formal cluster 3: refusal statuses and the host breaker', () => {
  let root: string
  let statePath: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-fr-c3-breaker-'))
    statePath = join(root, 'remote-health.json')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  async function recallAnswering(status: number, times: number): Promise<void> {
    const fetchImpl = (async () => new Response('refused', { status })) as unknown as typeof fetch
    for (let i = 0; i < times; i++) {
      await remoteRecall(
        [{ url: URL_, token: 't', scopes: ['group:test'], entries: [{ scope: 'group:test' }] }],
        'query',
        { statePath, fetchImpl, timeoutMs: 2_000, env: {} },
      )
    }
  }

  for (const status of [401, 403, 404]) {
    it(`Outbox.recall_refusal_no_count: ${status} answers on recall never open the host breaker`, async () => {
      await recallAnswering(status, BREAKER_FAILURE_THRESHOLD + 1)
      expect(isHostInCooldown(URL_, Date.now(), statePath).inCooldown).toBe(false)
    })
  }

  it('Outbox.recall_5xx_counts (non-vacuity): 503 answers on recall do open it', async () => {
    await recallAnswering(503, BREAKER_FAILURE_THRESHOLD)
    expect(isHostInCooldown(URL_, Date.now(), statePath).inCooldown).toBe(true)
  })

  it.fails('C4 (Outbox.recall_422_counts): 422 answers on recall never open the host breaker (which the outbox flush then obeys)', async () => {
    await recallAnswering(422, BREAKER_FAILURE_THRESHOLD)
    expect(isHostInCooldown(URL_, Date.now(), statePath).inCooldown).toBe(false)
  })
})
