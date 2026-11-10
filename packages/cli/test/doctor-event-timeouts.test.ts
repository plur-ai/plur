/**
 * W2+4 / D6 (overhaul): `plur init` now writes 20 s for the Claude Code event
 * hooks (plan mode, skill, agent, subagent), the same as the main hook. An
 * install made before keeps 10 s; `plur doctor` names each such entry. The
 * hook itself works within the old 10 s either way (soft deadline + keyword
 * fallback), so nothing relies on users re-running `plur init`.
 */
import { describe, it, expect } from 'vitest'
import { staleEventHookTimeouts } from '../src/commands/doctor.js'
import { buildInjectionHooks } from '../src/commands/init.js'

describe('doctor: stale event hook timeouts', () => {
  it('flags every plur hook-inject --event entry below 20 s', () => {
    const config = {
      hooks: {
        PreToolUse: [
          { matcher: 'EnterPlanMode', hooks: [{ type: 'command', command: '/home/u/.plur/bin/plur hook-inject --event plan_mode', timeout: 10 }] },
          { matcher: 'Skill', hooks: [{ type: 'command', command: '/home/u/.plur/bin/plur hook-inject --event skill', timeout: 20 }] },
          { matcher: 'Agent', hooks: [{ type: 'command', command: '/home/u/.plur/bin/plur hook-inject --event agent' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/home/u/.plur/bin/plur hook-observe', timeout: 3 }] },
        ],
        SubagentStart: [
          { matcher: '.*', hooks: [{ type: 'command', command: 'plur hook-inject --event subagent', timeout: 10 }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'plur hook-inject', timeout: 20 }] },
        ],
      },
    }
    const stale = staleEventHookTimeouts(config)
    expect(stale.map(s => s.event).sort()).toEqual(['plan_mode', 'subagent'])
    expect(stale.find(s => s.event === 'plan_mode')?.timeout).toBe(10)
    // No timeout set: Claude Code's default (60 s for command hooks) is not stale.
    expect(stale.find(s => s.event === 'agent')?.timeout).toBeUndefined()
  })

  it('what plur init writes now is not flagged', () => {
    const hooks = buildInjectionHooks('plur')
    expect(staleEventHookTimeouts({ hooks })).toEqual([])
  })

  it('a config without hooks has nothing stale', () => {
    expect(staleEventHookTimeouts({})).toEqual([])
  })
})
