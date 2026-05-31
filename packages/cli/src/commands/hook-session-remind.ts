import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'

/**
 * plur hook-session-remind — SessionStart hook.
 *
 * Outputs a forceful directive telling the LLM to call plur_session_start
 * before any other action. Combined with hook-session-guard (which blocks
 * tool calls), this creates an unavoidable enforcement loop.
 *
 * Input: JSON on stdin (Claude Code SessionStart hook format, ignored)
 * Output: JSON with additionalContext
 */

export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  // Silent pass-through for projects without plur configured (#95).
  if (!isPlurConfigured()) return

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        "Before other work, start this session's memory with plur:\n" +
        "1. Run ToolSearch 'select:mcp__plur__plur_session_start' on its own " +
        'and wait for the result. It is a deferred tool — its schema must ' +
        'load before it can be called.\n' +
        '2. Then call mcp__plur__plur_session_start exactly once with a short ' +
        'task description.\n' +
        'Do not batch steps 1 and 2 in the same turn, and do not repeat the ' +
        "call. A 'task required' error only means the schema wasn't loaded " +
        'yet — run ToolSearch, then call it once. A guard nudges you once if ' +
        'you start with another tool, but it never blocks your work.',
    },
  }
  process.stdout.write(JSON.stringify(output))
}
