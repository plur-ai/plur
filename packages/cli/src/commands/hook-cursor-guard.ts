import { existsSync } from 'fs'
import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import {
  readStdinJson,
  cursorConversationId,
  isPlurSessionStartTool,
  sentinelPath,
  markSessionStarted,
  incrementCounter,
} from '../lib/cursor-hook-io.js'

/**
 * plur hook-cursor-guard — Cursor `preToolUse` hook.
 *
 * Cursor's `preToolUse` fires for every tool call, including MCP tools
 * ("generic hook that fires for all tool types: Shell, Read, Write, MCP,
 * Task"), and its `permission: "deny"` output is DOCUMENTED to be enforced —
 * the direct analog of Claude Code's PreToolUse session guard. Unlike the
 * "fires for every tool call" fact (a direct doc quote), "deny is enforced"
 * is not independently verified against a live Cursor install — same
 * evidentiary basis (docs text, no live run) as the background/cloud-agent
 * uncertainty noted below, so it gets the same hedge (audit fix —
 * Popper-lens evaluator review, iteration 4, 2026-07-09: this used to read
 * as settled fact with no hedge, inconsistent with how this same file
 * treats an adjacent claim resting on identical evidence). This codebase's
 * test suite can only assert the HOOK PROCESS emits `{"permission":"deny"}`
 * — it cannot test that Cursor's runtime actually blocks the tool call in
 * response; Task 11 (manual verification) is what actually settles this.
 * Cursor hooks can only reliably DENY (an "allow" verdict does not override
 * Cursor's separate MCP approval/allowlist UI), so — same as the Claude
 * Code guard — this hook never emits an explicit allow, only a deny or
 * nothing.
 *
 * In normal interactive use this rarely fires a deny at all: sessionStart
 * already wrote the sentinel before the first tool call. Its INTENDED job is
 * the background/cloud-agent path, where sessionStart never runs — there
 * this is meant to deny until the agent calls plur_session_start itself,
 * which hook-cursor-post-tool then marks (postToolUse is confirmed to run
 * for cloud agents). Whether Cursor actually fires preToolUse on that path
 * at all is NOT independently confirmed (audit fix — evaluator review,
 * 2026-07-08: this used to be stated as settled fact) — if it doesn't, this
 * hook simply never runs there, the guard never denies anything, and
 * nothing ever prompts the agent to call plur_session_start; the
 * MAX_BLOCKS_BEFORE_FALLBACK path below never gets a chance to fire either.
 * Task 11 (manual verification) is what actually settles this.
 *
 * Deadlock prevention, same rationale as Claude Code's hook-session-guard
 * (#199): stop blocking after one nudge so a broken MCP server can't wedge
 * the agent into only ever being allowed to call plur_session_start.
 *
 * Audit fix: the original draft of this hook stopped blocking after the
 * fallback threshold WITHOUT writing the sentinel — which meant
 * hook-cursor-post-tool's reminder logic (gated on the sentinel existing)
 * stayed silent for the rest of the conversation too. That's a silent,
 * total, permanent memory-injection failure for exactly the background/
 * cloud-agent scenario this hook exists to handle — the one case where
 * nothing else marks the session started either. Once we've decided to stop
 * enforcing plur_session_start, we must also stop pretending the session
 * isn't started: markSessionStarted() below both ends the deadlock AND lets
 * degraded-mode reminders resume.
 *
 * Input: JSON on stdin — { tool_name, tool_input, conversation_id | session_id, ... }
 * Output: JSON on stdout — { permission: "deny", user_message, agent_message } or nothing
 */

const MAX_BLOCKS_BEFORE_FALLBACK = 1

function blockCountPath(conversationId: string): string {
  return `${sentinelPath(conversationId)}.guard-count`
}

export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  if (!isPlurConfigured()) return

  const input = readStdinJson()
  const toolName = String(input.tool_name ?? '')
  if (isPlurSessionStartTool(toolName)) return

  const conversationId = cursorConversationId(input)
  if (!conversationId) return // can't check — allow through rather than block blind

  if (existsSync(sentinelPath(conversationId))) return // session already started

  const blockCount = incrementCounter(blockCountPath(conversationId))
  if (blockCount > MAX_BLOCKS_BEFORE_FALLBACK) {
    // Audit fix: mark the session started here too (not just log and return),
    // so hook-cursor-post-tool's reminder path isn't permanently starved —
    // see the file-level comment above.
    markSessionStarted(conversationId)
    process.stderr.write(
      `[plur] guard: allowing tools after ${MAX_BLOCKS_BEFORE_FALLBACK} nudge(s) without an ` +
      'explicit session start. Marking the session started anyway so memory reminders can ' +
      'still resume in degraded mode. If plur_session_start never ran, the MCP server may be ' +
      'down — run `plur doctor` to diagnose.\n',
    )
    return
  }

  process.stdout.write(JSON.stringify({
    permission: 'deny',
    user_message: 'PLUR: starting memory for this session first.',
    agent_message:
      'Call plur_session_start once with a short task description before using other ' +
      'tools, so this session has memory. This will stop blocking automatically once that ' +
      'call succeeds, and only nudges once even if it does not.',
  }))
}
