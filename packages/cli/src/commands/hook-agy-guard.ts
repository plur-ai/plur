import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
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
 * plur hook-agy-guard — Antigravity `PreToolUse` hook.
 *
 * Session guard: deny tool calls until `plur_session_start` has run, with
 * the same one-nudge-then-give-up deadlock protection as the Claude Code
 * (#199), Cursor and Codex guards. Verified live on agy 1.1.21: a
 * `{"decision":"deny","reason":...}` output blocks the tool and the reason
 * reaches the model ("tool call denied by pre-tool hook: ...").
 *
 * Differences from the Codex guard worth knowing:
 *
 * - The verdict is FLAT `{decision, reason}` — no hookSpecificOutput
 *   envelope — and agy accepts `allow`/`ask`/`force_ask` too. We still only
 *   ever deny or stay silent: emitting `allow` would bypass agy's own
 *   permission prompting for tools PLUR has no opinion about.
 * - The sentinel is marked HERE when `plur_session_start` itself passes
 *   through, because agy's PostToolUse payload carries no tool name
 *   (stepIdx + error only) — there is no after-the-fact detection point.
 *   Marking on the way in is slightly optimistic (the user could still
 *   refuse the permission prompt), which costs at most one un-nudged
 *   session — the same trade every guard in this codebase already makes.
 * - In practice this guard rarely fires a deny at all: PreInvocation runs
 *   before any tool call and already marks the session. Its job is the path
 *   where PreInvocation somehow didn't run (hook disabled mid-session,
 *   config raced) — belt, not braces.
 * - Tool names are lowercased step types (`run_command`, `view_file`). How
 *   MCP tools are named in `toolCall.name` is NOT yet verified against a
 *   live MCP call; `isPlurSessionStartTool` matches on the
 *   `plur_session_start` suffix, which survives any prefixing scheme.
 *
 * GATING: same install-is-the-opt-in rule as hook-agy-pre-invocation, and
 * for the same reason — agy runs hooks with cwd = the hooks.json directory,
 * where a project-config walk can never succeed. When the payload names a
 * workspace, a project-level opt-out is honoured.
 *
 * Input:  camelCase JSON — { conversationId, toolCall: { name, args }, stepIdx, ... }
 * Output: {"decision":"deny","reason":"..."} or nothing.
 */

const MAX_BLOCKS_BEFORE_FALLBACK = 1

export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  await runAgyHook('agy guard', async () => {
    const input = readStdinJson()

    const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths as string[] : []
    if (workspaces.length > 0 && typeof workspaces[0] === 'string' && !isPlurConfigured(workspaces[0])) return

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
