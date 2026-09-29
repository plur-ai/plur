/**
 * Decision C5 (owner, round-2 board): a recall refusal — 401/403/404/422 —
 * never counts toward the per-host breaker, the same rule the write leg
 * follows (#1308). The recall leg feeds the SAME persisted breaker the outbox
 * flush obeys (remote-health.json, #785), so a counted 422 used to park queued
 * writes to every scope on the host. Adapted from the formal replay
 * formal-fr-c3-breaker.test.ts. Temp state file, mocked fetch only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { remoteRecall, isHostInCooldown, BREAKER_FAILURE_THRESHOLD } from '../src/remote-recall.js'

const URL_ = 'https://store.example.test'

describe('recall refusals and the per-host breaker (decision C5)', () => {
  let root: string
  let statePath: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-recall-refusal-'))
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

  for (const status of [401, 403, 404, 422]) {
    it(`${status} answers on recall never open the host breaker`, async () => {
      await recallAnswering(status, BREAKER_FAILURE_THRESHOLD + 1)
      expect(isHostInCooldown(URL_, Date.now(), statePath).inCooldown).toBe(false)
    })
  }

  it('a 422 neither counts nor resets: it does not wipe failures a 5xx already recorded', async () => {
    await recallAnswering(503, BREAKER_FAILURE_THRESHOLD - 1)
    await recallAnswering(422, 2)
    await recallAnswering(503, 1)
    expect(isHostInCooldown(URL_, Date.now(), statePath).inCooldown).toBe(true)
  })

  it('non-vacuity: 503 answers on recall do open it', async () => {
    await recallAnswering(503, BREAKER_FAILURE_THRESHOLD)
    expect(isHostInCooldown(URL_, Date.now(), statePath).inCooldown).toBe(true)
  })
})
