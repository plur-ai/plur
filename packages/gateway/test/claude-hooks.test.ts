import { describe, it, expect } from 'vitest'
import { buildClaudeHooks } from '../src/claude-hooks.js'

const CMD = 'npx @plur-ai/cli'
type Map = Record<string, Array<{ matcher?: string; hooks: Array<{ command?: string; args?: string[]; timeout?: number }> }>>
const lines = (map: Map) => Object.entries(map).flatMap(([event, entries]) => entries.flatMap(e => e.hooks.map(h =>
  `${event} [${e.matcher ?? ''}] ${[h.command, ...(h.args ?? [])].join(' ')} (${h.timeout}s)`))).sort()

describe('the Claude Code hook set plur init and plur-mcp init install', () => {
  it('is exactly this set of events, matchers, commands and timeouts', () => {
    expect(lines(buildClaudeHooks(CMD))).toEqual([
      `PostToolUse [Bash|Edit|Write|Agent] ${CMD} hook-observe --post (3s)`,
      `PostToolUse [mcp__.*__plur_session_start] ${CMD} hook-session-mark (3s)`,
      `PreToolUse [*] ${CMD} hook-session-guard (3s)`,
      `PreToolUse [Agent] ${CMD} hook-inject --event agent (10s)`,
      `PreToolUse [Bash|Edit|Write|Agent] ${CMD} hook-observe (3s)`,
      `PreToolUse [EnterPlanMode] ${CMD} hook-inject --event plan_mode (10s)`,
      `PreToolUse [Skill] ${CMD} hook-inject --event skill (10s)`,
      `SessionEnd [] ${CMD} hook-session-end (5s)`,
      `SessionStart [] ${CMD} hook-session-remind (3s)`,
      `SessionStart [compact] ${CMD} hook-inject --rehydrate (20s)`,
      `SessionStart [resume] ${CMD} hook-session-resume (3s)`,
      `Stop [*] ${CMD} hook-auto-rate claude (10s)`,
      `Stop [*] ${CMD} hook-learn-check (2s)`,
      `SubagentStart [.*] ${CMD} hook-inject --event subagent (10s)`,
      `UserPromptSubmit [] ${CMD} hook-inject (20s)`,
    ].sort())
  })

  it('puts the session guard first among PreToolUse hooks', () => {
    expect(buildClaudeHooks(CMD).PreToolUse[0].hooks[0].command).toBe(`${CMD} hook-session-guard`)
  })
})
