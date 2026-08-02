/**
 * plur_admin has to advertise itself as the gateway (#761) — the client half.
 *
 * #763 made the surface answerable in-band via plur_doctor's `tool_surface`,
 * which covers the agent that already suspects something is wrong. These tests
 * cover the agent that never gets that far: the only things it reliably reads
 * are tools/list descriptions, the session_start/status responses it calls
 * anyway, and — once it knows the gateway exists — plur_admin itself. Each of
 * those surfaces must (a) name the gateway and (b) be GENERATED from the same
 * registry the dispatcher routes on, because hand-maintained text drifts the
 * moment a tool is added or renamed, and a stale inventory an agent trusts is
 * worse than none.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur, settleVersionChecks, clearVersionCache } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import {
  getToolDefinitions, CURSOR_CORE_TOOL_NAMES,
  setActiveToolProfile, _resetActiveToolProfile, _resetSessionTelemetry,
} from '../src/tools.js'

/** The dispatchable set, computed from the registry the way the dispatcher does. */
const adminActions = () =>
  getToolDefinitions('full').map(t => t.name).filter(n => !CURSOR_CORE_TOOL_NAMES.has(n)).sort()

describe('plur_admin tool description is the gateway sign (#761)', () => {
  const admin = () => getToolDefinitions('lean').find(t => t.name === 'plur_admin')!

  it('enumerates every dispatchable action — add or remove a tool and this regenerates', () => {
    // The drift guard. The description is the ONE thing a client that only
    // reads tools/list sees, so it must be derived from the same list the
    // handler routes on. If someone replaces the generated inventory with
    // hand-typed text, the next registry change breaks this test instead of
    // silently shipping a wrong inventory.
    const description = admin().description
    for (const action of adminActions()) {
      expect(description, `action "${action}" missing from plur_admin's description`).toContain(action)
    }
  })

  it('states the true action count, computed not hardcoded', () => {
    expect(admin().description).toContain(`Gateway to the ${adminActions().length} PLUR operations`)
  })

  it('shows the calling convention with an example that is a real action', () => {
    const description = admin().description
    expect(description).toContain('{ action: "<tool name>", args: {')
    const example = description.match(/Example: \{ action: "([a-z_]+)"/)
    expect(example, 'description must carry a copyable example call').not.toBeNull()
    expect(adminActions(), `example action "${example![1]}" is not dispatchable`).toContain(example![1])
  })

  it('says a tools/list miss means moved, not gone — the #761 inference', () => {
    expect(admin().description).toMatch(/moved HERE — not that the MCP is unavailable/i)
  })

  it('points at { action: "help" } for the full runtime inventory', () => {
    expect(admin().description).toContain('{ action: "help" }')
  })

  it('stays within a sane description length for tool-list budgets', () => {
    expect(admin().description.length).toBeLessThanOrEqual(2500)
  })
})

describe('plur_admin { action: "help" } — the runtime discovery surface (#761)', () => {
  let client: Client
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-admin-help-'))
    // Hermetic per the server.test.ts pattern: temp-dir Plur, stubbed fetch so
    // createServer's fire-and-forget version check never leaves the process.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }))
    const server = await createServer(new Plur({ path: dir }), { profile: 'lean' })
    await settleVersionChecks()
    clearVersionCache()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(clientTransport)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    _resetActiveToolProfile()
    rmSync(dir, { recursive: true })
  })

  const callHelp = async () => {
    const result = await client.callTool({ name: 'plur_admin', arguments: { action: 'help' } })
    expect(result.isError).toBeFalsy()
    return JSON.parse((result.content as any)[0].text)
  }

  it('lists every dispatchable action with a one-line description and its argument schema', async () => {
    const data = await callHelp()
    expect(data.actions.map((a: any) => a.action)).toEqual(adminActions())
    for (const entry of data.actions) {
      expect(typeof entry.description, `${entry.action} has no description`).toBe('string')
      expect(entry.description.length, `${entry.action} has an empty description`).toBeGreaterThan(0)
      expect(entry.description, `${entry.action} description is not one line`).not.toContain('\n')
      expect(entry.args_schema?.type, `${entry.action} is missing its argument schema`).toBe('object')
    }
  })

  it('states the calling convention and the moved-not-gone rule', async () => {
    const data = await callHelp()
    expect(data.calling_convention).toContain('plur_admin { action: "<tool name>", args: { ... } }')
    expect(data.calling_convention).toMatch(/NOT that the MCP is unavailable/)
  })

  it('names the standalone tools so an agent does not route them through the gateway', async () => {
    const data = await callHelp()
    const standalone = getToolDefinitions('full').map(t => t.name).filter(n => CURSOR_CORE_TOOL_NAMES.has(n)).sort()
    expect(data.standalone_tools).toEqual(standalone)
    expect(data.standalone_note).toContain('call them directly')
  })

  it('help does not shadow a real tool name', () => {
    expect(getToolDefinitions('full').some(t => t.name === 'help')).toBe(false)
  })

  it('the unknown-action error offers help, so a lost agent recovers in one step', async () => {
    const result = await client.callTool({ name: 'plur_admin', arguments: { action: 'plur_nonexistent' } })
    const data = JSON.parse((result.content as any)[0].text)
    expect(data.success).toBe(false)
    expect(data.error).toContain('Unknown action')
    expect(data.error).toContain('help')
  })
})

describe('session_start and status name the profile + gateway (#761)', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-gateway-note-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions('full')
    _resetSessionTelemetry()
  })

  afterEach(() => {
    _resetActiveToolProfile()
    rmSync(dir, { recursive: true })
  })

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)!
    return tool.handler(args, plur) as Promise<any>
  }

  it('plur_status reports the active profile and a gateway one-liner under lean', async () => {
    setActiveToolProfile('lean')
    const status = await callTool('plur_status')
    expect(status.tool_profile).toBe('lean')
    expect(status.tool_surface_note).toContain('plur_admin { action: "<name>", args: {...} }')
    expect(status.tool_surface_note).toContain('help')
    expect(status.tool_surface_note).toMatch(/moved there, not that the MCP is down/)
  })

  it('plur_status omits the note under full — nothing is hidden there', async () => {
    setActiveToolProfile('full')
    const status = await callTool('plur_status')
    expect(status.tool_profile).toBe('full')
    expect(status.tool_surface_note).toBeUndefined()
  })

  it('session_start guide carries the profile + gateway line under lean', async () => {
    setActiveToolProfile('lean')
    const result = await callTool('plur_session_start', { task: 'anything at all' })
    expect(result.guide).toContain('Tool profile "lean"')
    expect(result.guide).toContain('plur_admin { action: "<tool name>", args: {...} }')
    expect(result.guide).toContain('{ action: "help" }')
  })

  it('session_start guide stays quiet about the gateway under full', async () => {
    setActiveToolProfile('full')
    const result = await callTool('plur_session_start', { task: 'anything at all' })
    expect(result.guide).not.toContain('Tool profile "')
  })
})
