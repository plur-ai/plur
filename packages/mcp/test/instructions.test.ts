/**
 * Server INSTRUCTIONS advertise per-engram scope selection (#296).
 *
 * The instructions block is advertised to every client on connect, so it's the
 * always-on place to teach agents that scope is content-driven and per-call —
 * not a once-per-session default that lets team knowledge fall back to 'global'.
 */
import { describe, it, expect } from 'vitest'
import { INSTRUCTIONS } from '../src/server.js'

describe('server INSTRUCTIONS — scope selection (#296)', () => {
  it('teaches per-engram scope selection by content', () => {
    expect(INSTRUCTIONS).toMatch(/SCOPE SELECTION/i)
    expect(INSTRUCTIONS).toMatch(/per engram/i)
  })

  it('names the team scope shape and warns against the global fallback', () => {
    expect(INSTRUCTIONS).toContain('group:<org>/<team>')
    expect(INSTRUCTIONS).toMatch(/never reaches the team store/i)
  })
})

/**
 * The instructions block is the ONE surface every MCP client receives on
 * connect, before any tool call — so it is where the plur_admin gateway must
 * be documented (#761). An agent that reads a 12-tool tools/list under the
 * lean profile otherwise concludes the missing tools don't exist.
 */
describe('server INSTRUCTIONS — plur_admin gateway (#761)', () => {
  it('documents the gateway calling convention', () => {
    expect(INSTRUCTIONS).toContain('plur_admin')
    expect(INSTRUCTIONS).toContain('{ action: "<tool name>", args: {...} }')
  })

  it('says a missing name means moved, not that the MCP is down', () => {
    expect(INSTRUCTIONS).toMatch(/MOVED behind plur_admin/)
    expect(INSTRUCTIONS).toMatch(/never conclude the server is unavailable/i)
  })

  it('points at both runtime discovery surfaces — help and tool_surface', () => {
    expect(INSTRUCTIONS).toContain('{ action: "help" }')
    expect(INSTRUCTIONS).toContain('tool_surface')
  })
})
