// EPI-1: Events I record can be found again with the timeline filters I ask for.
//
// Driven through the MCP tools an agent uses (plur_capture, plur_timeline).
// Each filter is checked both ways: the event that matches comes back, and an
// event that does not match is left out. The left-out event is first shown to
// exist in the unfiltered timeline, so "left out" cannot pass on an empty log.
// "Found again" also means after the server is restarted on the same store.
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'
import { callTool, connectMcp, offlineFetch } from '../helpers/privacy-folders-team-mcp.js'
import { useEmbedder } from '../helpers/store.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('EPI-1 recorded events come back with the timeline filters I ask for', () => {
  let s: McpSession | undefined
  let net: ReturnType<typeof offlineFetch> | undefined
  afterEach(async () => { await s?.close(); s = undefined; net?.restore() })

  it('time, agent, channel and text filters each return the matching event and leave the others out', async () => {
    net = offlineFetch()
    useEmbedder('off')
    s = await mcpSession({ profile: 'full' })

    const capture = async (args: Record<string, unknown>): Promise<string> => {
      const r = await s!.call('plur_capture', args)
      expect(r.isError, `recording an event failed: ${r.text}`).toBe(false)
      expect(typeof r.json?.id, `recording an event returned no id: ${r.text}`).toBe('string')
      return r.json.id as string
    }
    const timeline = async (args: Record<string, unknown> = {}): Promise<string[]> => {
      const r = await s!.call('plur_timeline', args)
      expect(r.isError, `the timeline query ${JSON.stringify(args)} failed: ${r.text}`).toBe(false)
      return (r.json?.episodes ?? []).map((e: { id: string }) => e.id)
    }

    const early = await capture({ summary: 'Fixed the billing export timeout', agent: 'claude', channel: 'claude-code' })
    await sleep(50)
    const cut = new Date().toISOString()
    await sleep(50)
    const late = await capture({ summary: 'Planned the onboarding emails', agent: 'cursor', channel: 'chat' })

    const all = await timeline()
    expect(all, 'precondition: the unfiltered timeline holds both recorded events').toEqual(expect.arrayContaining([early, late]))

    const since = await timeline({ since: cut })
    expect(since, 'filter since: the event recorded after the time should come back').toContain(late)
    expect(since, 'filter since: an event recorded before the time came back').not.toContain(early)

    const until = await timeline({ until: cut })
    expect(until, 'filter until: the event recorded before the time should come back').toContain(early)
    expect(until, 'filter until: an event recorded after the time came back').not.toContain(late)

    const byAgent = await timeline({ agent: 'cursor' })
    expect(byAgent, 'filter agent: the event recorded by agent "cursor" should come back').toContain(late)
    expect(byAgent, 'filter agent: an event recorded by another agent came back').not.toContain(early)

    const byChannel = await timeline({ channel: 'claude-code' })
    expect(byChannel, 'filter channel: the event from channel "claude-code" should come back').toContain(early)
    expect(byChannel, 'filter channel: an event from another channel came back').not.toContain(late)

    const bySearch = await timeline({ search: 'billing' })
    expect(bySearch, 'filter search: the event whose summary mentions "billing" should come back').toContain(early)
    expect(bySearch, 'filter search: an event that does not mention "billing" came back').not.toContain(late)

    // Two filters together narrow further: both must hold.
    const combined = await timeline({ agent: 'claude', search: 'onboarding' })
    expect(combined, 'filters agent "claude" + search "onboarding": no event matches both, yet one came back').toEqual([])
    const combinedHit = await timeline({ agent: 'claude', search: 'billing' })
    expect(combinedHit, 'filters agent "claude" + search "billing": the event matching both should come back').toEqual([early])

    // Found again after a restart: a new engine and server on the same store.
    const reopened = new Plur({ path: s.dir, autoDiscover: false })
    await reopened.ready()
    const conn = await connectMcp(reopened, { profile: 'full' })
    try {
      const r = await callTool(conn.client, 'plur_timeline', { agent: 'cursor' })
      const ids = (r.json?.episodes ?? []).map((e: { id: string }) => e.id)
      expect(ids, `after a restart, filter agent "cursor" should still find the event; got ${r.text}`).toEqual([late])
    } finally {
      await conn.close()
    }
  })
})
