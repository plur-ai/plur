import { type GlobalFlags } from '../plur.js'
import { hookFolderOn, payloadDir, cursorHookFolder } from '../lib/folder-gate.js'
import { readStdinJson, runCodexHook, codexSessionId } from '../lib/codex-hook-io.js'
import { exitWhenStoreIdle, EXIT_LOCK_WAIT_MS } from '../lib/store-lock-exit.js'
import { enqueueTurn, hasLeftoverBatches, spawnWorker, runWorker, agyReplySinceLastUser, type AutoRateEditor } from '../lib/auto-rate.js'

/**
 * plur hook-auto-rate <editor> — end-of-turn hook rating this session's injected
 * engrams against the reply. Its OWN hook entry on Stop (claude, codex, agy —
 * agy reads the reply from the transcript) or afterAgentResponse (cursor).
 * Rating: core `rateInjectedEngrams`; bookkeeping: lib/auto-rate.ts; this file maps payloads.
 * - Prints nothing on stdout on any path (empty is "no opinion"); fail-open.
 * - Opens no store when nothing was injected (see `enqueueTurn`).
 * - Only queues the turn and starts a detached worker, so store work never runs
 *   inside the editor's timeout or gets killed holding the store lock.
 */

const EDITORS: readonly AutoRateEditor[] = ['claude', 'codex', 'cursor', 'agy']

/**
 * Hard ceiling on the whole run: exit quietly before the shortest budget the
 * hook is registered with (10s, every editor), so a slow store costs one
 * unrated turn rather than a harness timeout error.
 */
const CEILING_MS = parseInt(process.env.PLUR_AUTO_RATE_CEILING_MS ?? '', 10) || 9_000

/**
 * The worker's own ceiling: only an immortal-process guard, far above any
 * real run. When it fires, the exit waits (bounded) until no store write is
 * in flight (exitWhenStoreIdle).
 */
const WORKER_CEILING_MS = parseInt(process.env.PLUR_AUTO_RATE_WORKER_CEILING_MS ?? '', 10) || 15 * 60_000

/**
 * How long the watchdog waits for an in-flight store write. The watchdog is
 * armed relative to process start (see below), so Node startup + CEILING_MS
 * + this wait stays under the 10s budget on a slow machine too.
 */
const WATCHDOG_LOCK_WAIT_MS = 800

interface Turn {
  sessionId: string
  reply: string
  cwd?: string
  /** Cursor: the scope decided for the whole workspace; null for none. */
  workspaceScope?: string | null
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
      // Codex: the same id source as the writer (hook-codex-inject records
      // under codexSessionId, which falls back to conversation_id). Reading
      // session_id alone would miss those lists.
      const sessionId = editor === 'codex' ? codexSessionId(input) : str(input.session_id)
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
    // Never exit inside a store write — wait (bounded) for the store to go idle.
    const guard = setTimeout(() => { void exitWhenStoreIdle(EXIT_LOCK_WAIT_MS) }, WORKER_CEILING_MS)
    guard.unref()
    await runCodexHook('auto-rate worker', async () => { await runWorker(editor, sessionId, flags) })
    return
  }

  // The inline fallback below opens the store, so the watchdog waits
  // (bounded, inside the editor's 10s budget) for no store write in flight.
  // The ceiling counts from process start, not from here: module import and
  // Node startup (slow on Windows) are part of the editor's budget.
  const elapsedMs = Math.round(process.uptime() * 1000)
  const watchdog = setTimeout(() => { void exitWhenStoreIdle(WATCHDOG_LOCK_WAIT_MS) }, Math.max(0, CEILING_MS - elapsedMs))
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

    // Same gate as every other hook: the folder map. Only a folder the map
    // resolves to on is rated; off and ask are untouched. agy runs hooks from
    // its config dir, so only its workspace path is meaningful there (see
    // hook-agy-guard): no workspace, no folder to decide about.
    if (editor === 'agy') {
      if (turn.cwd && !hookFolderOn(turn.cwd, flags)) return
    } else if (editor === 'cursor') {
      // Cursor sends no cwd, only workspace_roots, and runs the hook wherever
      // it likes (a plugin's folder): decide for the workspace. The worker gets
      // the scope decided for the whole workspace, or an explicit none, so it
      // never re-decides from one root.
      const folder = cursorHookFolder(input, flags)
      if (folder.policy.mode !== 'on' || !folder.dir) return
      turn.cwd = folder.dir
      turn.workspaceScope = folder.policy.scope ?? null
    } else if (!hookFolderOn(payloadDir({ cwd: turn.cwd }), flags)) {
      return
    }

    const queued = enqueueTurn({ editor, sessionId: turn.sessionId, reply: turn.reply, cwd: turn.cwd, workspaceScope: turn.workspaceScope })
    if (!queued && !hasLeftoverBatches(editor, turn.sessionId)) return
    // If the worker cannot be started, do the work inline rather than drop
    // it, bounded by the watchdog above.
    if (!spawnWorker(editor, turn.sessionId, flags)) {
      // Inline, inside the editor's hook budget: never wait for another
      // worker's lock here (that worker, or the next turn's, drains it).
      await runWorker(editor, turn.sessionId, flags, { waitForLockMs: 0 })
    }
  })
}
