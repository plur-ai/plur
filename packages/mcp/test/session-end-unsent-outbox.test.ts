/**
 * Session end tells the agent about team memories that were never sent.
 *
 * Team-scoped writes whose remote store was unreachable sit in the local
 * outbox. Session start retries them and reports what it could not send, but
 * session end used to return a clean result with no word about the queue: the
 * agent closed the session believing everything reached the team.
 *
 * Session end now states the true unsent count when the queue is not empty,
 * states nothing about it when the queue is empty, and reports a failure to
 * read the queue instead of passing it off as an empty one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

describe('plur_session_end reports unsent team memories', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions('full')
  const sessionEnd = tools.find(t => t.name === 'plur_session_end')!

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-session-end-outbox-'))
    plur = new Plur({ path: dir })
    await plur.ready()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('states the true unsent count when team memories are still queued', async () => {
    vi.spyOn(plur, 'outboxCount').mockResolvedValue(2)
    const result = await sessionEnd.handler({ summary: 'did work', engram_suggestions: [] }, plur) as any

    expect(result.outbox, 'session end said nothing about the queue').toBeDefined()
    expect(result.outbox.pending).toBe(2)
    expect(String(result.outbox.warning)).toMatch(/\b2\b.*not (?:been )?sent/)
  })

  it('says nothing about unsent memories when the queue is empty', async () => {
    const result = await sessionEnd.handler({ summary: 'did work', engram_suggestions: [] }, plur) as any
    expect(result.outbox).toBeUndefined()
    expect(result.outbox_error).toBeUndefined()
  })

  it('reports a queue that could not be read instead of looking clean', async () => {
    vi.spyOn(plur, 'outboxCount').mockRejectedValue(new Error('outbox unreadable'))
    const result = await sessionEnd.handler({ summary: 'did work', engram_suggestions: [] }, plur) as any
    expect(result.outbox).toBeUndefined()
    expect(result.outbox_error).toBe('outbox unreadable')
    expect(String(result.outbox_warning)).toMatch(/could not be checked/)
  })
})
