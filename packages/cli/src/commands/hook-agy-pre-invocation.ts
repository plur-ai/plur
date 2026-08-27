import { readFileSync, writeFileSync } from 'fs'
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
    if (workspaces.length > 0 && typeof workspaces[0] === 'string' && !isPlurConfigured(workspaces[0])) return

    const conversationId = agyConversationId(input)
    if (!conversationId) return

    // Which user message is the model about to act on?
    const transcriptPath = String(input.transcriptPath ?? '')
    const user = transcriptPath ? lastUserInput(transcriptPath) : null

    // One RECALL per user turn; one EMIT per invocation. The marker file
    // holds {step, message} so mid-turn invocations replay the cached text
    // instead of re-running recall (which costs seconds) or staying silent
    // (which loses the memory the moment a tool result arrives — see the
    // file comment).
    const stepMarkerPath = agyCounterPath(conversationId, 'turncache')
    let lastInjectedStep = -1
    let cachedMessage = ''
    try {
      const cached = JSON.parse(readFileSync(stepMarkerPath, 'utf8')) as { step?: number; message?: string }
      lastInjectedStep = typeof cached.step === 'number' ? cached.step : -1
      cachedMessage = typeof cached.message === 'string' ? cached.message : ''
    } catch { /* first turn */ }

    const isFirst = Number(input.invocationNum ?? 0) === 0 && lastInjectedStep === -1
    const isNewTurn = user !== null && user.stepIndex > lastInjectedStep
    if (!isFirst && !isNewTurn) {
      // Mid-turn invocation: replay this turn's memory so it survives tool
      // calls. No recall, no counters — just the cached text.
      if (cachedMessage) emitInjectSteps(cachedMessage)
      return
    }

    agyMarkSessionStarted(conversationId)

    const plur = createPlur(flags)
    const projectConfig = readProjectConfig()
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

    if (!message) return

    // Record BEFORE emitting: a crash between write and emit costs one
    // injection; the reverse order would re-run recall for the same turn
    // forever if the marker write ever failed.
    try {
      writeFileSync(stepMarkerPath, JSON.stringify({ step: user?.stepIndex ?? 0, message }))
    } catch { /* degrade to re-recall next invocation */ }

    emitInjectSteps(message)
  })
}
