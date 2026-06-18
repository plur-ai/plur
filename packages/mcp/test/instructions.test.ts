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
