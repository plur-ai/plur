// TOOL-3: When team memories queued for sending could not be sent, my agent is
// told at session end; it is never a silent success.
//
// Setup: a team store whose server cannot be reached (fetch fails; no network
// is used). Memories learned for that team are queued locally. Driven over the
// MCP wire against a server built from source.
//
// Three checks, kept apart so a red one is legible:
//  - session end, with team memories still queued: the agent is told the true
//    unsent count (the promise as worded); a word like "outbox" beside a zero
//    is a silent success. A control: with nothing queued, no unsent claim;
//  - session start, which retries the queue: a retry that cannot send is
//    reported, and a retry that itself crashes is reported too.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'

const SCOPE = 'group:example/team'
const CONFIG = JSON.stringify({
  stores: [{ url: 'https://team-store.invalid/sse', token: 'eval-token', scope: SCOPE, shared: true, readonly: false }],
  index: false,
})

/**
 * Every unsent count session end states: numbers under a key about the queue
 * (pending, unsent, queued, outbox ... count) in the JSON reply, and numbers
 * the text puts next to "unsent", "not sent", "queued" or "pending".
 */
function statedUnsent(r: { json?: any; text: string }): number[] {
  const out: number[] = []
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'number' && /(pending|unsent|queued|outbox)/i.test(path)) out.push(node)
    else if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}.${i}`))
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`)
  }
  walk(r.json, '')
  for (const m of r.text.matchAll(/\b(\d+)\b[^.\n]{0,40}?\b(unsent|not (?:been )?sent|queued|pending)\b/gi)) out.push(Number(m[1]))
  for (const m of r.text.matchAll(/\b(unsent|not (?:been )?sent|queued|pending)\b[^.\n\d]{0,20}?\b(\d+)\b/gi)) out.push(Number(m[2]))
  return [...new Set(out)]
}

describe('TOOL-3 unsent team memories are reported, never a silent success', () => {
  let s: McpSession
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    realFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed: team store unreachable') }) as never
  })
  afterEach(async () => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
    await s?.close()
  })

  async function queueTeamMemories(): Promise<number> {
    await s.plur.learn('Team convention: every migration ships with a rollback script', { scope: SCOPE })
    await s.plur.learn('Team convention: feature flags are removed within two sprints', { scope: SCOPE })
    // The remote write runs in the background; wait until both sit in the queue.
    for (let i = 0; i < 100 && (await s.plur.outboxCount()) < 2; i++) await new Promise(r => setTimeout(r, 50))
    return s.plur.outboxCount()
  }

  it('session end tells the agent that team memories are still unsent', async () => {
    s = await mcpSession({ profile: 'lean', config: CONFIG })
    const start = await s.call('plur_session_start', { task: 'write the migration' })
    expect(start.isError, `precondition: session start ran: ${start.text}`).toBe(false)
    expect(await queueTeamMemories(), 'precondition: two team memories are queued, unsent').toBe(2)

    const end = await s.call('plur_session_end', {
      summary: 'Wrote the migration.',
      engram_suggestions: [],
      session_id: start.json?.session_id,
    })
    expect(end.isError, `session end failed outright: ${end.text}`).toBe(false)
    const unsent = await s.plur.outboxCount()
    expect(unsent, 'precondition: the team memories are still queued at session end').toBe(2)
    // The count it states must be the true one: a word like "outbox" with pending:0
    // is a silent success (fourth audit A4-04).
    expect(statedUnsent(end), `session end did not tell the agent that ${unsent} team memories are unsent; it read: ${end.text}`)
      .toContain(unsent)
    expect(statedUnsent(end).filter(n => n !== unsent), `session end states a wrong unsent count; it read: ${end.text}`).toEqual([])
  })

  it('control: with nothing queued, session end claims no unsent memories', async () => {
    s = await mcpSession({ profile: 'lean', config: CONFIG })
    const start = await s.call('plur_session_start', { task: 'write the migration' })
    expect(start.isError, `precondition: session start ran: ${start.text}`).toBe(false)
    expect(await s.plur.outboxCount(), 'precondition: nothing is queued').toBe(0)
    const end = await s.call('plur_session_end', { summary: 'Nothing for the team.', engram_suggestions: [], session_id: start.json?.session_id })
    expect(end.isError, `session end failed outright: ${end.text}`).toBe(false)
    expect(statedUnsent(end).filter(n => n > 0), `session end claims unsent memories with an empty queue; it read: ${end.text}`).toEqual([])
  })

  it('session start reports a retry that could not send the queued team memories', async () => {
    s = await mcpSession({ profile: 'lean', config: CONFIG })
    expect(await queueTeamMemories(), 'precondition: two team memories are queued, unsent').toBe(2)

    const start = await s.call('plur_session_start', { task: 'next session' })
    expect(start.isError, `session start failed outright: ${start.text}`).toBe(false)
    expect(await s.plur.outboxCount(), 'precondition: the retry could not send them').toBe(2)
    const outbox = start.json?.outbox
    // A missing count is "nothing said": 0, so it fails as an assertion, not a type error.
    const pendingSaid = Number(outbox?.pending ?? start.json?.outbox_needs_action?.count ?? 0)
    expect(pendingSaid,
      `session start retried the queue, could not send, and did not say so; it read: ${start.text.slice(0, 600)}`)
      .toBeGreaterThan(0)
  })

  it('session start reports a retry that crashed, instead of looking clean', async () => {
    s = await mcpSession({ profile: 'lean', config: CONFIG })
    expect(await queueTeamMemories(), 'precondition: two team memories are queued, unsent').toBe(2)
    vi.spyOn(s.plur, 'flushOutbox').mockRejectedValue(new Error('team store refused the connection'))

    const start = await s.call('plur_session_start', { task: 'next session' })
    expect(start.isError, `session start failed outright: ${start.text}`).toBe(false)
    expect(start.text,
      `the failed retry of the queue was swallowed; session start read: ${start.text.slice(0, 600)}`)
      .toContain('team store refused the connection')
  })
})
