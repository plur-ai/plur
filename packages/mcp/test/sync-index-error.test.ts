/**
 * plur_sync / plur_status surface background index failures — closes #272
 * (iter-1 audit gap M-11, Critic F-CRIT-006).
 *
 * The MCP plur_sync handler returned the git SyncResult while the background
 * index/reembed chain was still in flight, and that chain's .catch swallowed
 * any rejection — a failed pass reported success. The handler now blocks on
 * waitForIndex() and attaches index_error + warning when the pass failed.
 * plur_status passes status().index_error through.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, type IndexSyncError } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

describe('MCP index-error surfacing (#272)', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  const fail: IndexSyncError = {
    op: 'sync-from-yaml',
    message: 'disk on fire',
    at: '2026-07-02T00:00:00.000Z',
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-idxerr-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions('full')
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const result = await tool.handler(args, plur)
    if (typeof result !== 'object' || result === null) throw new Error(`${name} returned ${typeof result}, not an object`)
    return result as Record<string, unknown>
  }

  it('plur_sync attaches index_error and a warning when the background pass failed', async () => {
    plur.lastIndexError = () => fail
    const result = await callTool('plur_sync')
    expect(result.action).toBeTruthy()
    expect(result.index_error).toEqual(fail)
    expect(String(result.warning)).toContain('sync-from-yaml')
  })

  it('plur_sync omits index_error when the pass succeeded', async () => {
    const result = await callTool('plur_sync')
    expect(result.index_error).toBeUndefined()
  })

  it('plur_status passes status().index_error through without dropping the rest of the report', async () => {
    // `status()` is ASYNC. The overlay used to be `{ ...realStatus(), … }`,
    // which spreads a PROMISE — an object with no own enumerable keys — so it
    // produced `{ index_error }` and silently dropped every other field. That
    // went unnoticed because the only assertion was on index_error. It has to
    // be awaited, and the surviving fields have to be checked, or the same
    // mistake is invisible again.
    await plur.learn('the rest of a status report must survive the overlay', { scope: 'global' })

    const real = await plur.status()
    // Guard the fixture: a zero count would make the comparison below pass on
    // a dropped field too, since `undefined` vs 0 is the only tell.
    expect(real.engram_count, 'fixture produced no engrams').toBeGreaterThan(0)

    const realStatus = plur.status.bind(plur)
    plur.status = async (options) => ({ ...(await realStatus(options)), index_error: fail })

    const result = await callTool('plur_status')
    expect(result.index_error).toEqual(fail)
    // Every field the handler forwards out of status() is still there.
    expect(result.engram_count).toBe(real.engram_count)
    expect(result.episode_count).toBe(real.episode_count)
    expect(result.pack_count).toBe(real.pack_count)
    expect(result.storage_root).toBe(real.storage_root)
    expect(result.locked_count).toBe(real.locked_count)
    expect(result.tension_count).toBe(real.tension_count)
    expect(result.versioned_engram_count).toBe(real.versioned_engram_count ?? 0)
    expect(result.outbox_count).toBe(real.outbox_count ?? 0)
    expect(result.history_events).toEqual(real.history_events)
  })

  it('plur_status omits index_error on a healthy instance', async () => {
    const result = await callTool('plur_status')
    expect(result.index_error).toBeUndefined()
  })
})
