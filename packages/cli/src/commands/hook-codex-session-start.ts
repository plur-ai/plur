import { createPlur, type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import { readStdinJson, runCodexHook, codexSessionId, markSessionStarted, emitContext } from '../lib/codex-hook-io.js'
import { readProjectConfig } from '@plur-ai/core'

/**
 * plur hook-codex-session-start — Codex `SessionStart` hook.
 *
 * Fires on startup, resume, clear and compact (the `source` field says
 * which). Advisory: Codex never blocks session creation on a hook, so this
 * only marks the sentinel and delivers an opening batch of engrams.
 *
 * Delivery is the ordinary `hookSpecificOutput.additionalContext` channel —
 * verified reaching the model on codex-cli 0.149.1. No `.mdc`-style
 * workaround is needed here; that exists only because Cursor drops
 * `additional_context` at conversation-creation time.
 *
 * BM25-only, deliberately. Codex DOES support `async: true` as of 0.149.1,
 * but an async hook's context is delivered at the next safe point rather
 * than to the triggering turn, so going async would silently put memory one
 * turn behind (and, in `codex exec`, drop it entirely). This hook has to
 * just BE fast: hybrid search cold-starts the BGE embedder (~20s once the
 * store passes a few thousand engrams — the failure PR #502 fixed for
 * Claude Code); BM25 alone measured 0.74s against 4,290 engrams.
 *
 * Input:  JSON on stdin — { session_id, cwd, hook_event_name, model, permission_mode, source }
 * Output: JSON on stdout — { hookSpecificOutput: { hookEventName, additionalContext } }
 */
export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  await runCodexHook('codex session-start', async () => {
    if (!isPlurConfigured()) return

    const input = readStdinJson()
    const sessionId = codexSessionId(input)
    if (!sessionId) return

    markSessionStarted(sessionId)

    // Wrapped like the Cursor equivalent: if inject() throws AFTER the
    // sentinel is written, the guard has already stopped enforcing, so
    // silence here would be indistinguishable from "0 engrams matched".
    // Say so explicitly instead.
    let context: string
    try {
      const plur = createPlur(flags)
      const projectConfig = readProjectConfig()
      const injectOpts = { budget: 3000, ...(projectConfig.scope ? { scope: projectConfig.scope } : {}) }

      const result = await plur.inject('general session start', injectOpts)
      const body = result.count > 0
        ? [result.directives, result.constraints, result.consider].filter(Boolean).join('\n')
        : ''

      const header = `[PLUR Memory — session started, ${result.count} engrams injected]` +
        (projectConfig.scope ? `\nProject scope: ${projectConfig.scope} — use this scope for plur_learn calls` : '')

      context = body ? `${header}\n\n${body}` : header
    } catch (err: unknown) {
      context = '[PLUR Memory — injection FAILED at session start] ' +
        `(${(err as Error)?.message ?? 'unknown error'}). Recalled memory is unavailable; run ` +
        '`plur doctor` in a TERMINAL (the CLI command — it checks ~/.codex wiring and hook trust; ' +
        'the plur_doctor MCP tool only checks the embedder/remote store, not this).'
    }

    emitContext('SessionStart', context)
  })
}
