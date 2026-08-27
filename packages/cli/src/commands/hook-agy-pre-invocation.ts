import { createPlur, type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import {
  readStdinJson,
  runAgyHook,
  injectWithFallback,
  agyConversationId,
  agyMarkSessionStarted,
  agyCounterPath,
  agyIncrementCounter,
  agyTextHash,
  readAgyTurnCache,
  writeAgyTurnCache,
  lastUserInput,
  emitInjectSteps,
} from '../lib/agy-hook-io.js'
import { readProjectConfig } from '@plur-ai/core'

/**
 * plur hook-agy-pre-invocation — Antigravity `PreInvocation` hook.
 *
 * The whole injection surface for this harness in one event: agy has no
 * SessionStart, no per-prompt event, and no end-of-turn context channel, so
 * session-open batch, per-prompt recall and the learn nudge all ride here.
 *
 * TWO PROBLEMS this hook has to solve that the other harnesses hand us for
 * free:
 *
 * 1. NO PROMPT IN THE PAYLOAD. PreInvocation's stdin is counters and paths
 *    only. The user's text lives in the transcript JSONL the payload points
 *    at (`transcriptPath`) — `lastUserInput()` digs it out. When the
 *    transcript can't be read (format drift, torn write), we degrade to the
 *    generic session batch rather than failing.
 *
 * 2. FIRES SEVERAL TIMES PER TURN. PreInvocation runs before EVERY model
 *    invocation — planning, tool-result digestion, final answer — verified
 *    live (one probe turn injected its marker twice). And ephemeral messages
 *    are shown ONLY to the invocation they were injected into: verified live,
 *    a model that quoted the memory block on invocation 0 reported "no PLUR
 *    Memory block" after a tool call, because the ephemeral had expired with
 *    the invocation that received it. So the turn's rendered message is
 *    CACHED per conversation and re-emitted on every invocation of the SAME
 *    turn — recall runs once per user message, visibility lasts the whole
 *    turn, and nothing accumulates in history because ephemerals never do.
 *
 *    Turn identity is (step_index, text hash), not step_index alone: the
 *    transcript is Antigravity's internal format, and if step_index ever
 *    disappears or restarts, a step-only comparison freezes on turn one and
 *    replays it forever (data-loss audit M6/F10). The text hash breaks that
 *    tie — a different user message is a new turn regardless of what the
 *    step counter says. When the transcript itself is unreadable, the cached
 *    turn is replayed (there is no way to detect a turn boundary without
 *    it), with a stderr line saying so — replaying stale-but-real memory
 *    beats injecting nothing, and the log distinguishes it from healthy
 *    mid-turn replay.
 *
 * GATING: unlike the Claude Code/Cursor/Codex hooks, this does not silently
 * no-op when the cwd has no PLUR project config — agy runs hooks with cwd =
 * the directory containing hooks.json (~/.gemini/config), where
 * isPlurConfigured() can never be true (its walk deliberately skips
 * $HOME-level configs, #247/#521). The install itself is the opt-in here:
 * these hooks exist only because the user ran `plur init --antigravity`,
 * and they fire only inside agy. When the payload names a workspace, we do
 * respect a per-project opt-out by checking that path instead.
 *
 * Input:  camelCase JSON — { conversationId, invocationNum, transcriptPath, workspacePaths, ... }
 * Output: {"injectSteps":[{"ephemeralMessage": "..."}]} or nothing.
 */

const TURNS_BETWEEN_NUDGES = 6

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  await runAgyHook('agy pre-invocation', async () => {
    const input = readStdinJson()

    const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths as string[] : []
    const workspace = (workspaces.length > 0 && typeof workspaces[0] === 'string') ? workspaces[0] : null
    if (workspace && !isPlurConfigured(workspace)) return

    const conversationId = agyConversationId(input)
    if (!conversationId) return

    // Which user message is the model about to act on?
    const transcriptPath = String(input.transcriptPath ?? '')
    const user = transcriptPath ? lastUserInput(transcriptPath) : null
    const userHash = user ? agyTextHash(user.text) : ''

    // One RECALL per user turn; one EMIT per invocation. The cache record
    // holds this turn's rendered message so mid-turn invocations replay it
    // instead of re-running recall (which costs seconds) or staying silent
    // (which loses the memory the moment a tool result arrives — see the
    // file comment). readAgyTurnCache validates the conversationId stored
    // INSIDE the record, so a sanitized-path collision between two
    // conversations reads as "no cache", never as another conversation's
    // memory (F9).
    const cached = readAgyTurnCache(conversationId)

    const isFirst = cached === null && Number(input.invocationNum ?? 0) === 0
    // `cached === null` counts as a new turn when a user message exists: it
    // covers both the genuine first turn and the fail-open path where the
    // cache dir is unusable (writeAgyTurnCache no-ops). In the latter case
    // every invocation re-recalls — slow, but memory keeps flowing, which is
    // the right direction to degrade.
    const isNewTurn = user !== null &&
      (cached === null || user.stepIndex > cached.step || userHash !== cached.textHash)
    if (!isFirst && !isNewTurn) {
      // Mid-turn invocation — or an unreadable transcript, which is
      // indistinguishable from one. Replay this turn's memory so it survives
      // tool calls. No recall, no counters — just the cached text.
      if (cached !== null && user === null && transcriptPath) {
        process.stderr.write('[plur] agy: transcript unreadable — replaying the last turn\'s memory rather than re-recalling.\n')
      }
      if (cached?.message) emitInjectSteps(cached.message)
      return
    }

    agyMarkSessionStarted(conversationId)

    const plur = createPlur(flags)
    // The workspace path, not process.cwd(): agy runs hooks with cwd = the
    // hooks.json directory (~/.gemini/config), where the .plur.yaml walk can
    // never succeed — cwd here would silently strip project scoping from
    // every agy recall AND from the scope line the model is told to learn
    // under (evaluator audit B1).
    const projectConfig = readProjectConfig(workspace ?? process.cwd())
    const injectOpts = {
      budget: isFirst ? 3000 : 2000,
      ...(projectConfig.scope ? { scope: projectConfig.scope } : {}),
    }
    const task = user?.text ?? 'general session start'

    let message: string
    try {
      const { result, mode } = await injectWithFallback(plur, task, injectOpts)
      const body = result.count > 0
        ? [result.directives, result.constraints, result.consider].filter(Boolean).join('\n')
        : ''
      const header = isFirst
        ? `[PLUR Memory — session started, ${result.count} engrams injected via ${mode}]` +
          (projectConfig.scope ? `\nProject scope: ${projectConfig.scope} — use this scope for plur_learn calls` : '')
        : `[PLUR Memory — ${result.count} engrams recalled for this prompt via ${mode}]`
      message = body ? `${header}\n\n${body}` : (isFirst ? header : '')
    } catch (err: unknown) {
      // Only worth a message on the FIRST turn — an honest "memory is broken"
      // beats silence there. Mid-session, stderr is enough.
      process.stderr.write(`[plur] agy injection failed: ${(err as Error)?.message ?? 'unknown error'}\n`)
      message = isFirst
        ? '[PLUR Memory — injection FAILED at session start] Recalled memory is unavailable; run `plur doctor` in a terminal.'
        : ''
    }

    // Learn nudge, folded in here because no other agy event can carry
    // model-visible text: PostInvocation/Stop can only retry or halt.
    const turns = agyIncrementCounter(agyCounterPath(conversationId, 'turncount'))
    if (turns % TURNS_BETWEEN_NUDGES === 0) {
      message += (message ? '\n\n' : '') +
        '[PLUR Memory] If anything this session is worth remembering — a correction, a ' +
        'preference, a convention — call plur_learn now with an explicit domain and scope. ' +
        'Call plur_session_end before you finish.'
    }

    // Record BEFORE emitting, and record even when the message is empty:
    // an empty result is still THIS turn's result, and skipping the write
    // made every mid-turn invocation re-run a full recall (evaluator audit
    // M5). A failed write degrades to exactly that — re-recall next
    // invocation — which is the acceptable direction.
    writeAgyTurnCache({
      conversationId,
      step: user?.stepIndex ?? 0,
      textHash: userHash,
      message,
    })

    if (!message) return

    emitInjectSteps(message)
  })
}
