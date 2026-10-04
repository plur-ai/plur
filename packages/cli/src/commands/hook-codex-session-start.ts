import { createPlur, type GlobalFlags } from '../plur.js'
import { hookFolderPolicy, payloadDir, sessionSettings, clearFolderAsk, isResumeStart } from '../lib/folder-gate.js'
import { readStdinJson, runCodexHook, codexSessionId, markSessionStarted, emitContext, injectWithFallback } from '../lib/codex-hook-io.js'
import { resolveProjectRemote, projectRemoteRefusalNotice } from '../lib/project-remote.js'
import { recordInjected } from '../lib/auto-rate.js'

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
    const input = readStdinJson()
    // #1347 option C: a resumed session keeps its id, but SessionEnd deleted
    // its nonces. Forget that it was asked, so its first prompt asks again
    // with a fresh nonce. Only on resume: startup, clear and compact keep it.
    if (isResumeStart(input)) clearFolderAsk(String(input.session_id ?? input.conversation_id ?? '')) // the key hook-codex-inject asks under
    // #1347: only an `on` folder gets a session batch. An `ask` folder is
    // asked by hook-codex-inject on the first prompt; `off` is silent.
    const dir = payloadDir(input)
    const policy = hookFolderPolicy(dir, flags)
    if (policy.mode !== 'on') return
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
      // #1198: carry the project's remote settings so Enterprise team memory
      // reaches Codex at session start too. The helper carries #1196's trust
      // gate, so this cannot reintroduce the exfiltration path.
      const projectRemote = resolveProjectRemote(plur, dir)
      const projectConfig = sessionSettings(policy, projectRemote.config)
      const injectOpts = {
        budget: 3000,
        ...(projectConfig.scope ? { scope: projectConfig.scope } : {}),
        ...(projectRemote.remoteProject ? { remote_project: projectRemote.remoteProject } : {}),
      }

      const { result, mode } = await injectWithFallback(plur, 'general session start', injectOpts)
      recordInjected('codex', sessionId, result.injected_ids) // #1310 auto-rate
      const body = result.count > 0
        ? [result.directives, result.constraints, result.consider].filter(Boolean).join('\n')
        : ''

      const header = `[PLUR Memory — session started, ${result.count} engrams injected via ${mode}]` +
        (projectConfig.scope ? `\nProject scope: ${projectConfig.scope} — use this scope for plur_learn calls` : '')

      // Never silent (#1198): if the project declared remote settings we
      // refused, say so here — this is the only model-visible surface.
      const refusal = projectRemote.refusedFrom
        ? `${projectRemoteRefusalNotice(projectRemote.refusedFrom, plur.storageRoot)}\n\n`
        : ''
      context = refusal + (body ? `${header}\n\n${body}` : header)
    } catch (err: unknown) {
      context = '[PLUR Memory — injection FAILED at session start] ' +
        `(${(err as Error)?.message ?? 'unknown error'}). Recalled memory is unavailable; run ` +
        '`plur doctor` in a TERMINAL (the CLI command — it checks ~/.codex wiring and hook trust; ' +
        'the plur_doctor MCP tool only checks the embedder/remote store, not this).'
    }

    emitContext('SessionStart', context)
  })
}
