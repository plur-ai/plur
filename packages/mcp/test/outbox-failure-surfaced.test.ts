/**
 * A failed outbox flush must reach the caller.
 *
 * `plur_sync` and `plur_session_start` both call `flushOutbox()` and both used
 * to wrap it in `catch { /* logged inside flushOutbox *\/ }`. The `outbox` field
 * in their responses is only added when the flush RESULT is truthy — so a
 * failure produced a response byte-identical to a sync with nothing to flush.
 *
 * That is the worst shape a failure can take here, because the caller is an
 * agent. It sees a clean result, tells the user the sync worked, and the
 * engrams routed to a remote store stay queued indefinitely with nobody
 * looking. A log line inside `flushOutbox` is not a report to the caller — it
 * goes to the server's stderr, which the agent never reads.
 *
 * These tests force the flush to throw and assert the failure is visible in the
 * tool's own output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

describe('a failed outbox flush is surfaced, not swallowed', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions('full')

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-outbox-surface-'))
    plur = new Plur({ path: dir })
    await plur.ready()
    await plur.learn('an engram so the store is not empty', { scope: 'global' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('plur_sync reports the failure instead of a clean result', async () => {
    vi.spyOn(plur, 'flushOutbox').mockRejectedValue(new Error('remote unreachable: ECONNREFUSED'))
    const tool = tools.find(t => t.name === 'plur_sync')!

    const result = await tool.handler({}, plur) as Record<string, unknown>

    expect(result.outbox_error, 'the failure did not reach the caller').toBe(
      'remote unreachable: ECONNREFUSED',
    )
    expect(String(result.outbox_warning)).toMatch(/still queued locally/)
    expect(String(result.outbox_warning)).toMatch(/NOT pushed/)
  })

  it('plur_session_start reports it too', async () => {
    vi.spyOn(plur, 'flushOutbox').mockRejectedValue(new Error('remote unreachable: ECONNREFUSED'))
    const tool = tools.find(t => t.name === 'plur_session_start')!

    const result = await tool.handler({ task: 'anything' }, plur) as Record<string, unknown>

    expect(result.outbox_error).toBe('remote unreachable: ECONNREFUSED')
    expect(String(result.outbox_warning)).toMatch(/still queued locally/)
  })

  it('a SUCCESSFUL sync carries no error field — the signal has to mean something', async () => {
    // Guards against "always report a warning", which would be just as useless
    // as never reporting one.
    const tool = tools.find(t => t.name === 'plur_sync')!
    const result = await tool.handler({}, plur) as Record<string, unknown>
    expect(result.outbox_error).toBeUndefined()
    expect(result.outbox_warning).toBeUndefined()
  })

  it('the sync itself still succeeds — a queued outbox is not a failed sync', async () => {
    // The git sync genuinely did run. Downgrading it to a thrown error would
    // break callers for whom a queued outbox is normal (offline, slow remote).
    vi.spyOn(plur, 'flushOutbox').mockRejectedValue(new Error('remote unreachable'))
    const tool = tools.find(t => t.name === 'plur_sync')!
    const result = await tool.handler({}, plur) as Record<string, unknown>
    expect(result.action, 'sync should still report its own outcome').toBeDefined()
  })
})
