import { createPlur, type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import { readStdinJson, runCodexHook, codexSessionId, markSessionStarted, emitContext, injectWithFallback } from '../lib/codex-hook-io.js'
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
 * Synchronous, hybrid-first with a BM25 fallback on a soft deadline — see
 * `injectWithFallback`, which holds the measurements (4.7s hybrid / 1.6s
 * BM25 on a 5,775-engram store, 2026-08-27) and the reason the old "~20s
 * embedder cold start" figure was retired. Async would be worse, not
 * faster: Codex delivers an async hook's context at the next safe point,
 * NOT to the triggering turn — in `codex exec` that means never.
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

      const { result, mode } = await injectWithFallback(plur, 'general session start', injectOpts)
      const body = result.count > 0
        ? [result.directives, result.constraints, result.consider].filter(Boolean).join('\n')
        : ''

      const header = `[PLUR Memory — session started, ${result.count} engrams injected via ${mode}]` +
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
