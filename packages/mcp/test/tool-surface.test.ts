/**
 * The tool surface has to be answerable in-band (#761).
 *
 * Under the lean profile most `plur_*` tools stopped being standalone and
 * became actions on `plur_admin`. That change is invisible to a client that
 * only reads `tools/list`: an agent carrying a memory of the old names looks
 * one up, misses, and concludes the MCP is unavailable. It never *calls* the
 * missing name, so the server's helpful "call it via plur_admin" error — which
 * only fires on a call — never reaches it.
 *
 * The observed failure is the sharp version: `plur_doctor` reported green while
 * the caller switched to an HTTP fallback, because doctor answers "is the
 * engine healthy" and the real question was "what is callable". Those are
 * different questions, and only one of them had an answer.
 *
 * So doctor now reports the surface too, and these tests exist to keep that
 * report honest — a description that drifts from what is actually exposed is
 * worse than none, because it is the thing an agent would trust.
 */
import { describe, it, expect } from 'vitest'
import {
  describeToolSurface, resolveToolProfile, getToolDefinitions,
  CURSOR_CORE_TOOL_NAMES,
} from '../src/tools.js'

describe('resolveToolProfile', () => {
  it('defaults to lean, and only the documented values change it', () => {
    expect(resolveToolProfile({} as NodeJS.ProcessEnv)).toBe('lean')
    expect(resolveToolProfile({ PLUR_TOOL_PROFILE: 'full' } as NodeJS.ProcessEnv)).toBe('full')
    expect(resolveToolProfile({ PLUR_TOOL_PROFILE: 'cursor' } as NodeJS.ProcessEnv)).toBe('cursor')
    // Anything unrecognised must fall back to the safe default rather than
    // exposing 41 tools because someone typoed the value.
    expect(resolveToolProfile({ PLUR_TOOL_PROFILE: 'FULL' } as NodeJS.ProcessEnv)).toBe('lean')
    expect(resolveToolProfile({ PLUR_TOOL_PROFILE: 'nonsense' } as NodeJS.ProcessEnv)).toBe('lean')
  })
})

describe('describeToolSurface', () => {
  it('reports exactly what tools/list exposes — not an approximation', () => {
    // The load-bearing assertion. If these ever diverge, doctor is telling an
    // agent it can call something it cannot, which is worse than silence.
    for (const profile of ['lean', 'cursor', 'full'] as const) {
      const surface = describeToolSurface(profile)
      const actual = getToolDefinitions(profile).map(t => t.name).sort()
      expect(surface.standalone, `standalone drifted from tools/list for "${profile}"`).toEqual(actual)
    }
  })

  it('every advertised admin action is really dispatchable', () => {
    // An action listed here that plur_admin cannot route is a dead end an
    // agent would follow on our say-so.
    const surface = describeToolSurface('lean')
    const everything = new Set(getToolDefinitions('full').map(t => t.name))
    for (const action of surface.admin_actions) {
      expect(everything.has(action), `advertised action "${action}" does not exist`).toBe(true)
      expect(CURSOR_CORE_TOOL_NAMES.has(action), `"${action}" is standalone — it should not be listed as an admin action`).toBe(false)
    }
  })

  it('standalone + admin_actions together cover the whole tool set', () => {
    // No tool may be unreachable: if a name is in neither list, an agent has
    // no way to discover it at all.
    const surface = describeToolSurface('lean')
    const reachable = new Set([...surface.standalone, ...surface.admin_actions])
    for (const t of getToolDefinitions('full')) {
      expect(reachable.has(t.name), `"${t.name}" is reachable by neither route`).toBe(true)
    }
  })

  it('names the tools that moved, so a lookup miss is self-correcting', () => {
    const surface = describeToolSurface('lean')
    // The specific names from the incident report.
    for (const moved of ['plur_recall_hybrid', 'plur_stores_list', 'plur_suggest_scope']) {
      expect(surface.admin_actions, `${moved} should be listed as an admin action`).toContain(moved)
      expect(surface.standalone).not.toContain(moved)
    }
    // And the note must say a miss means "moved", not "gone" — that inference
    // is the entire bug.
    expect(surface.note).toMatch(/moved, NOT that the MCP is unavailable/)
    expect(surface.note).toContain('plur_admin')
  })

  it('says so plainly when nothing is hidden', () => {
    const full = describeToolSurface('full')
    expect(full.admin_actions).toEqual([])
    expect(full.note).toContain('All tools are exposed directly')
    // plur_admin itself is not needed as a router under full, but the surface
    // must still be the real list.
    expect(full.standalone.length).toBeGreaterThan(surfaceCount('lean'))
  })

  it('keeps the diagnostic door standalone in every profile', () => {
    // doctor/status are where an agent goes when it thinks the MCP is broken.
    // If they were ever consolidated, the only in-band way to discover the
    // surface would itself be undiscoverable.
    for (const profile of ['lean', 'cursor', 'full'] as const) {
      const { standalone } = describeToolSurface(profile)
      expect(standalone, `plur_doctor must stay standalone in "${profile}"`).toContain('plur_doctor')
      expect(standalone, `plur_status must stay standalone in "${profile}"`).toContain('plur_status')
    }
  })
})

function surfaceCount(profile: 'lean' | 'cursor' | 'full'): number {
  return describeToolSurface(profile).standalone.length
}
