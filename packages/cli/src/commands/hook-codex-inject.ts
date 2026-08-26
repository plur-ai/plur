import { createPlur, type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import { readStdinJson, runCodexHook, codexSessionId, markSessionStarted, emitContext } from '../lib/codex-hook-io.js'
import { readProjectConfig } from '@plur-ai/core'

/**
 * plur hook-codex-inject — Codex `UserPromptSubmit` hook.
 *
 * The load-bearing hook: recalls engrams relevant to THIS prompt and returns
 * them as `additionalContext`, which Codex appends to the turn. Verified
 * reaching the model on codex-cli 0.149.1.
 *
 * Synchronous and BM25-only — see `codex-hooks.ts` for why async is the
 * wrong trade here even though Codex now supports it.
 *
 * Also marks the session sentinel. In `codex exec` (a one-shot, no TUI)
 * SessionStart and UserPromptSubmit both fire, but a resumed or forked
 * session may deliver only one of them; whichever arrives first should stop
 * the guard from nagging.
 *
 * Input:  JSON on stdin — { session_id, turn_id, cwd, hook_event_name, prompt, ... }
 * Output: JSON on stdout — { hookSpecificOutput: { hookEventName, additionalContext } }
 *         or nothing at all when there is nothing worth saying.
 */
export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  await runCodexHook('codex inject', async () => {
    if (!isPlurConfigured()) return

    const input = readStdinJson()
    const sessionId = codexSessionId(input)
    const prompt = String(input.prompt ?? '').trim()

    if (sessionId) markSessionStarted(sessionId)

    // No prompt text means nothing to search on. Staying silent is a valid
    // hook result; emitting an empty context block would just burn tokens.
    if (!prompt) return

    try {
      const plur = createPlur(flags)
      const projectConfig = readProjectConfig()
      const injectOpts = { budget: 2000, ...(projectConfig.scope ? { scope: projectConfig.scope } : {}) }

      const result = await plur.inject(prompt, injectOpts)
      if (result.count === 0) return

      const body = [result.directives, result.constraints, result.consider].filter(Boolean).join('\n')
      if (!body) return

      emitContext(
        'UserPromptSubmit',
        `[PLUR Memory — ${result.count} engrams recalled for this prompt]\n\n${body}`,
      )
    } catch (err: unknown) {
      // Diagnostics go to stderr: Codex parses stdout as the hook result, and
      // a non-JSON byte there would invalidate the whole output.
      process.stderr.write(`[plur] codex inject failed: ${(err as Error)?.message ?? 'unknown error'}\n`)
    }
  })
}
