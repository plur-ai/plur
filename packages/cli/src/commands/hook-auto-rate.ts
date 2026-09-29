import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import { readStdinJson, runCodexHook } from '../lib/codex-hook-io.js'
import { enqueueTurn, hasLeftoverBatches, spawnWorker, runWorker, agyReplySinceLastUser, type AutoRateEditor } from '../lib/auto-rate.js'

/**
 * plur hook-auto-rate <editor> — end-of-turn hook that rates the engrams
 * injected this session against the assistant's reply (#1310).
 *
 * Registered as its OWN hook entry on each editor's end-of-turn event, next to
 * (never inside) the existing nudge/cleanup hooks:
 *
 *   editor   event                payload fields used
 *   claude   Stop                 session_id, last_assistant_message, stop_hook_active, cwd
 *   codex    Stop                 session_id, last_assistant_message, stop_hook_active, cwd
 *   cursor   afterAgentResponse   conversation_id, text
 *   agy      Stop                 conversationId, transcriptPath, workspacePaths
 *                                 (no reply text in the payload — read from the transcript)
 *
 * The rating itself lives in core (`rateInjectedEngrams`) and the bookkeeping
 * in lib/auto-rate.ts. This file only turns each editor's payload into
 * (session id, reply). It prints nothing on stdout on any path — for every
 * editor above, empty output is the valid "no opinion" result, and a Stop
 * hook that printed would be read as hook output. Fail-open: any error is a
 * stderr line and exit 0.
 *
 * Skip-cheap: with nothing injected this session (and auto-capture off) no
 * store is opened — see `enqueueTurn`.
 *
 * Bounded (#1318 audit M1): the hook only queues the turn and starts a
 * detached worker (`hook-auto-rate --worker <editor> <session>`), then exits.
 * The store work runs in the worker, outside the editor's timeout, so a large
 * store can no longer push the hook past its budget or get it killed while
 * it holds the store lock.
 */

const EDITORS: readonly AutoRateEditor[] = ['claude', 'codex', 'cursor', 'agy']

/**
 * Hard ceiling on the whole run: exit quietly before the shortest budget the
 * hook is registered with (10s, every editor), so a slow store costs one
 * unrated turn rather than a harness timeout error.
 */
const CEILING_MS = parseInt(process.env.PLUR_AUTO_RATE_CEILING_MS ?? '', 10) || 9_000

/**
 * The worker's own ceiling: only an immortal-process guard (#504), far above
 * any real run. It is checked between turns, never inside a store write.
 */
const WORKER_CEILING_MS = parseInt(process.env.PLUR_AUTO_RATE_WORKER_CEILING_MS ?? '', 10) || 15 * 60_000

interface Turn {
  sessionId: string
  reply: string
  cwd?: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Map one editor's payload to (session, reply), or null to skip. Exported for tests. */
export function readTurn(editor: AutoRateEditor, input: Record<string, unknown>): Turn | null {
  switch (editor) {
    case 'claude':
    case 'codex': {
      // A continuation Stop is the turn a Stop hook's own nudge forced; the
      // real reply was already rated on the Stop before it.
      if (input.stop_hook_active === true) return null
      const sessionId = str(input.session_id)
      if (!sessionId) return null
      return { sessionId, reply: str(input.last_assistant_message), cwd: str(input.cwd) || undefined }
    }
    case 'cursor': {
      const sessionId = str(input.conversation_id) || str(input.session_id)
      if (!sessionId) return null
      return { sessionId, reply: str(input.text) }
    }
    case 'agy': {
      const sessionId = str(input.conversationId)
      if (!sessionId) return null
      const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths : []
      const cwd = typeof workspaces[0] === 'string' ? workspaces[0] as string : undefined
      return { sessionId, reply: agyReplySinceLastUser(str(input.transcriptPath)), cwd }
    }
  }
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  if (args[0] === '--worker') {
    const editor = args[1] as AutoRateEditor
    const sessionId = args[2] ?? ''
    if (!EDITORS.includes(editor) || !sessionId) return
    const guard = setTimeout(() => process.exit(0), WORKER_CEILING_MS)
    guard.unref()
    await runCodexHook('auto-rate worker', async () => { await runWorker(editor, sessionId, flags) })
    return
  }

  const watchdog = setTimeout(() => process.exit(0), CEILING_MS)
  watchdog.unref()

  await runCodexHook('auto-rate', async () => {
    const editor = args[0] as AutoRateEditor
    if (!EDITORS.includes(editor)) {
      process.stderr.write(`[plur] hook-auto-rate: unknown editor "${args[0] ?? ''}" — expected ${EDITORS.join('|')}\n`)
      return
    }
    const input = readStdinJson()
    const turn = readTurn(editor, input)
    if (!turn || !turn.reply.trim()) return

    // Same opt-out as every other hook: a project without PLUR is untouched.
    // agy runs hooks from its config dir, so only its workspace path is
    // meaningful there (see hook-agy-pre-invocation).
    if (editor === 'agy') {
      if (turn.cwd && !isPlurConfigured(turn.cwd)) return
    } else if (!isPlurConfigured(turn.cwd ?? process.cwd())) {
      return
    }

    const queued = enqueueTurn({ editor, sessionId: turn.sessionId, reply: turn.reply, cwd: turn.cwd })
    if (!queued && !hasLeftoverBatches(editor, turn.sessionId)) return
    // If the worker cannot be started, do the work inline rather than drop
    // it — the pre-worker behaviour, bounded by the watchdog above.
    if (!spawnWorker(editor, turn.sessionId, flags)) {
      await runWorker(editor, turn.sessionId, flags)
    }
  })
}
