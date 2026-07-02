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
    tools = getToolDefinitions()
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur)
  }

  it('plur_sync attaches index_error and a warning when the background pass failed', async () => {
    ;(plur as any).lastIndexError = () => fail
    const result = await callTool('plur_sync') as any
    expect(result.action).toBeTruthy()
    expect(result.index_error).toEqual(fail)
    expect(String(result.warning)).toContain('sync-from-yaml')
  })

  it('plur_sync omits index_error when the pass succeeded', async () => {
    const result = await callTool('plur_sync') as any
    expect(result.index_error).toBeUndefined()
  })

  it('plur_status passes status().index_error through', async () => {
    const realStatus = plur.status.bind(plur)
    ;(plur as any).status = () => ({ ...realStatus(), index_error: fail })
    const result = await callTool('plur_status') as any
    expect(result.index_error).toEqual(fail)
  })

  it('plur_status omits index_error on a healthy instance', async () => {
    const result = await callTool('plur_status') as any
    expect(result.index_error).toBeUndefined()
  })
})
