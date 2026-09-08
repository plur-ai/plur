/**
 * Linking an engram back to the session that produced it (#960),
 * and recording why an engram was retired (#959).
 *
 * `sources[].session_id` is filled from `session_episode_id`, and until now
 * exactly one caller passed it. The session-end tool was not one of them — even
 * though it receives a session identifier as an argument and uses it two lines
 * later to capture an episode. That path writes a large share of all engrams, so
 * most engrams had no session to point at.
 *
 * The fix has an ordering consequence worth protecting with a test: the episode
 * must be captured BEFORE the engrams are written, because the engrams point at
 * it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, readHistory } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'

describe('session provenance (#960) and retirement reasons (#959)', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur) as Promise<any>
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-session-provenance-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions()
    _resetSessionTelemetry()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('links an engram written at session end back to that session', async () => {
    const session_id = 'sess-abc-123'
    await callTool('plur_session_end', {
      session_id,
      summary: 'Worked on the provenance profile',
      engram_suggestions: [{ statement: 'Migrations run before deploys', type: 'behavioral' }],
    })

    const all = await plur.recall('migrations deploys')
    const engram = all.find(e => e.statement.includes('Migrations run before deploys'))
    expect(engram).toBeDefined()

    // The session is recorded, rather than the null it used to be.
    const source = (engram as any).sources?.[0]
    expect(source).toBeDefined()
    expect(source.session_id).toBeTruthy()
    expect(source.session_id).not.toBeNull()

    // And it points at a real episode, not at the raw session identifier.
    expect(source.session_id).toMatch(/^EP-/)
    expect((engram as any).episode_ids).toContain(source.session_id)
  })

  it('captures the episode before the engrams, because they point at it', async () => {
    const result = await callTool('plur_session_end', {
      session_id: 'sess-ordering',
      summary: 'Ordering matters here',
      engram_suggestions: ['A statement worth keeping'],
    })
    expect(result.engrams_created).toBe(1)

    const timeline = plur.timeline({})
    const episode = timeline.find(e => e.summary === 'Ordering matters here')
    expect(episode).toBeDefined()

    const all = await plur.recall('statement worth keeping')
    const engram = all.find(e => e.statement.includes('A statement worth keeping'))
    expect((engram as any).sources?.[0]?.session_id).toBe(episode!.id)
  })

  it('marks an end-of-session summary as inferred, not asserted', async () => {
    // The model wrote this by reading the conversation. Nobody stated it
    // outright, and the record should not imply that anyone did.
    await callTool('plur_session_end', {
      session_id: 'sess-claim',
      summary: 'A session',
      engram_suggestions: ['Something the model concluded'],
    })
    const all = await plur.recall('something the model concluded')
    const engram = all.find(e => e.statement.includes('Something the model concluded'))
    expect((engram as any).claim_class).toBe('inferred')
  })

  it('still works when no session identifier is supplied', async () => {
    const result = await callTool('plur_session_end', {
      summary: 'No session identifier here',
      engram_suggestions: ['Written without a session'],
    })
    expect(result.engrams_created).toBe(1)
  })

  it('records why an engram was retired', async () => {
    const engram = await plur.learn('This will be retired', { type: 'behavioral' })
    await callTool('plur_forget', { id: engram.id, reason: 'superseded by a newer measurement' })

    const events = readHistory(dir, new Date().toISOString().slice(0, 7))
    const retired = events.find(
      e => e.engram_id === engram.id && (e.event === 'engram_retired' || e.event === 'engram_decremented'),
    )
    expect(retired).toBeDefined()
    expect(retired!.data.reason).toBe('superseded by a newer measurement')
  })

  it('still retires without a reason, rather than refusing', async () => {
    const engram = await plur.learn('Retired with no reason given', { type: 'behavioral' })
    const result = await callTool('plur_forget', { id: engram.id })
    expect(result.success).toBe(true)
  })
})

/**
 * A session end that cannot store one suggestion still stores the rest, and
 * says which failed (#1002 review). The episode is captured before the learns
 * because they point at it; a throwing learn used to abort the loop with the
 * episode and some engrams already written and the call reported as failed.
 */
describe('plur_session_end and a suggestion that cannot be stored', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>
  const callTool = async (name: string, args: Record<string, unknown> = {}) =>
    tools.find(t => t.name === name)!.handler(args, plur) as Promise<any>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-session-fail-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions()
    _resetSessionTelemetry()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('stores the others, names the failure, and keeps the episode', async () => {
    const result = await callTool('plur_session_end', {
      summary: 'One bad apple',
      engram_suggestions: [
        'The first learning is fine',
        'The key is AKIAIOSFODNN7EXAMPLE, remember it',
        'The third learning is fine too',
      ],
    })
    expect(result.engrams_created).toBe(2)
    expect(result.engrams_failed).toHaveLength(1)
    expect(result.engrams_failed[0].index).toBe(1)
    expect(result.engrams_failed[0].error).toMatch(/Secret detected/)
    expect(result.hint).toMatch(/could not be stored/)
    expect((await plur.list()).length).toBe(2)
    expect((await plur.timeline({})).some(e => e.summary === 'One bad apple')).toBe(true)
  })

  it('a malformed suggestion is refused before anything is written', async () => {
    await expect(callTool('plur_session_end', {
      summary: 'Nothing should land',
      engram_suggestions: ['fine', 42],
    })).rejects.toThrow(/engram_suggestions\[1\]/)
    expect((await plur.list()).length).toBe(0)
    expect((await plur.timeline({})).some(e => e.summary === 'Nothing should land')).toBe(false)
  })
})
