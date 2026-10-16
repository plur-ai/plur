// TOOL-2: An operation that deletes or overwrites can never be run through the
// general gateway tool, so my client still asks me first.
//
// The client asks first when a tool carries destructiveHint. The gateway
// (plur_admin) carries one static annotation for every action, so a deleting
// action run through it would slip past that prompt. Driven over the MCP wire
// against a server built from source, lean (default) profile.
import { afterEach, describe, expect, it } from 'vitest'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'

describe('TOOL-2 deleting through the gateway is refused, and the direct tool still asks', () => {
  let s: McpSession
  afterEach(async () => { await s?.close() })

  it('forgetting a memory through plur_admin is refused and the memory survives', async () => {
    s = await mcpSession({ profile: 'lean' })
    const keep = await s.plur.learn('Release notes are written by the on-call engineer', { scope: 'global' })
    expect((await s.plur.recall('release notes on-call engineer', { limit: 5 })).map(e => e.id),
      'precondition: the memory exists and is found before the attempt').toContain(keep.id)

    const res = await s.call('plur_admin', { action: 'plur_forget', args: { id: keep.id, reason: 'eval' } })
    expect(res.json?.success === false || res.isError,
      `the gateway ran a forget instead of refusing it: ${res.text}`).toBe(true)
    expect(res.text, `the refusal does not tell the agent to call plur_forget directly: ${res.text}`)
      .toContain('plur_forget')

    const after = await s.plur.recall('release notes on-call engineer', { limit: 5 })
    expect(after.map(e => e.id), 'the memory was deleted through the gateway').toContain(keep.id)
  })

  it('every deleting tool is callable directly with its warning, and refused by the gateway', async () => {
    s = await mcpSession({ profile: 'lean' })
    const direct = (await s.client.listTools()).tools as Array<{ name: string; annotations?: { destructiveHint?: boolean } }>
    const help = await s.call('plur_admin', { action: 'help' })
    const gatewayActions: string[] = (help.json?.actions ?? []).map((a: { action: string }) => a.action)
    expect(gatewayActions.length, `precondition: the gateway lists its actions: ${help.text.slice(0, 200)}`).toBeGreaterThan(0)

    // Tools whose job is to delete memory. Literal list from what the
    // promise is about, not read from the code under test.
    for (const name of ['plur_forget', 'plur_packs_uninstall', 'plur_tensions_purge']) {
      const tool = direct.find(t => t.name === name)
      expect(tool, `${name} deletes memory but is not callable directly, so the only way to it is the gateway`).toBeTruthy()
      expect(tool!.annotations?.destructiveHint,
        `${name} is listed without destructiveHint, so the client would not ask before running it`).toBe(true)
      expect(gatewayActions, `the gateway offers ${name} as one of its actions`).not.toContain(name)
      const viaGateway = await s.call('plur_admin', { action: name, args: {} })
      expect(viaGateway.json?.success === false || viaGateway.isError,
        `the gateway accepted ${name}: ${viaGateway.text}`).toBe(true)
    }

    // And no tool marked destructive is offered by the gateway at all.
    const destructive = direct.filter(t => t.annotations?.destructiveHint === true).map(t => t.name)
    expect(destructive.length, 'precondition: some direct tools are marked destructive').toBeGreaterThan(0)
    for (const name of destructive) {
      expect(gatewayActions, `the gateway offers the destructive tool ${name}`).not.toContain(name)
    }
  })
})
