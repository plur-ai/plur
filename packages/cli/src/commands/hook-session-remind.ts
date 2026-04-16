import { type GlobalFlags } from '../plur.js'

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
  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        'MANDATORY FIRST ACTION — DO THIS NOW BEFORE ANYTHING ELSE:\n' +
        "1. Call ToolSearch with query 'select:mcp__plur__plur_session_start'\n" +
        "2. Call mcp__plur__plur_session_start with the user's task description\n" +
        '3. Only THEN proceed with any other work\n\n' +
        'A PreToolUse guard will BLOCK all other tool calls until this is done. ' +
        'This is not optional. This is not a suggestion. Do it now.',
    },
  }
  process.stdout.write(JSON.stringify(output))
}
