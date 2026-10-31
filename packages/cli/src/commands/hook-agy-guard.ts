import { type GlobalFlags } from '../plur.js'
import { hookFolderOn } from '../lib/folder-gate.js'
import {
  readStdinJson,
  runAgyHook,
  isPlurSessionStartTool,
  agyConversationId,
  agyIsSessionStarted,
  agyMarkSessionStarted,
  agyIncrementCounter,
  agyCounterPath,
} from '../lib/agy-hook-io.js'

/**
 * plur hook-agy-guard — Antigravity `PreToolUse` session guard: deny tool calls until
 * `plur_session_start` has run (one nudge, then give up, to avoid deadlock).
 * - Verdict is FLAT `{decision, reason}`; only deny or silence — `allow` would bypass agy's prompts.
 * - The sentinel is marked HERE when `plur_session_start` passes (PostToolUse has no tool
 *   name); matched on the name suffix. Mostly a backstop: PreInvocation marks it first.
 * - Install is the opt-in (cwd is the hooks.json dir); a workspace opt-out is honoured.
 * Input: camelCase JSON { conversationId, toolCall: { name, args }, stepIdx, ... }.
 * Output: {"decision":"deny","reason":"..."} or nothing.
 */

const MAX_BLOCKS_BEFORE_FALLBACK = 1

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  await runAgyHook('agy guard', async () => {
    const input = readStdinJson()

    const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths as string[] : []
    // With a workspace, silent unless the folder map says on.
    if (workspaces.length > 0 && typeof workspaces[0] === 'string' && !hookFolderOn(workspaces[0], flags)) return

    const toolCall = (input.toolCall && typeof input.toolCall === 'object')
      ? input.toolCall as Record<string, unknown>
      : {}
    const toolName = String(toolCall.name ?? '')

    const conversationId = agyConversationId(input)
    if (!conversationId) return // can't track — allow through rather than block blind

    if (isPlurSessionStartTool(toolName)) {
      agyMarkSessionStarted(conversationId)
      return
    }

    if (agyIsSessionStarted(conversationId)) return

    const blockCount = agyIncrementCounter(agyCounterPath(conversationId, 'guard-count'))
    if (blockCount > MAX_BLOCKS_BEFORE_FALLBACK) {
      agyMarkSessionStarted(conversationId)
      process.stderr.write(
        `[plur] guard: allowing tools after ${MAX_BLOCKS_BEFORE_FALLBACK} nudge(s) without an ` +
        'explicit session start. Marking the session started so memory can resume in degraded ' +
        'mode. If plur_session_start never ran, the MCP server may be down — run `plur doctor`.\n',
      )
      return
    }

    process.stdout.write(JSON.stringify({
      decision: 'deny',
      reason:
        'PLUR: call plur_session_start once with a short task description before using other ' +
        'tools, so this session has memory. This stops blocking as soon as that call succeeds, ' +
        'and only nudges once even if it does not.',
    }))
  })
}
