import { createPlur, type GlobalFlags } from '../plur.js'
import { hookFolderPolicy, payloadDir, sessionSettings, folderAskOnce, createAskPlur } from '../lib/folder-gate.js'
import { readStdinJson, runCodexHook, codexSessionId, markSessionStarted, isSessionStarted, emitContext, injectWithFallback } from '../lib/codex-hook-io.js'
import { resolveProjectRemote, projectRemoteRefusalNotice } from '../lib/project-remote.js'
import { recordInjected } from '../lib/auto-rate.js'

/**
 * plur hook-codex-inject — Codex `UserPromptSubmit` hook.
 *
 * The load-bearing hook: recalls engrams relevant to THIS prompt and returns
 * them as `additionalContext`, which Codex appends to the turn. Verified
 * reaching the model on codex-cli 0.149.1.
 *
 * Synchronous, hybrid-first with a BM25 fallback on a soft deadline — see
 * `injectWithFallback`. Async is the wrong trade here even though Codex
 * supports it: its context lands on the NEXT turn, not this one.
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
    const input = readStdinJson()
    const sessionId = codexSessionId(input)
    const prompt = String(input.prompt ?? '').trim()

    // #1347: off is silent; ask prints the one question on the first prompt
    // of the session (no memories, no sentinel), then nothing.
    const dir = payloadDir(input)
    const policy = hookFolderPolicy(dir, flags)
    if (policy.mode === 'off') return
    if (policy.mode === 'ask') {
      // No store discovery: asking must not register this folder's .plur store.
      const ask = folderAskOnce({ dir, policy, sessionId, flags, plur: createAskPlur(flags), prompt })
      if (ask) emitContext('UserPromptSubmit', ask)
      return
    }

    // The trust / remote-refusal notices belong to the session's FIRST
    // context, not every prompt (audit 1228-c #6): SessionStart says them,
    // and this hook repeats them only when it is the first hook this session
    // saw (a resumed or forked session may deliver no SessionStart). Read
    // before marking, so "first" means first.
    const firstForSession = !(sessionId && isSessionStarted(sessionId))
    if (sessionId) markSessionStarted(sessionId)

    // No prompt text means nothing to search on. Staying silent is a valid
    // hook result; emitting an empty context block would just burn tokens.
    if (!prompt) return

    try {
      const plur = createPlur(flags)
      // #1198: pass the project's remote settings so PLUR Enterprise team
      // memory actually reaches Codex — this hook read `.plur.yaml` for `scope`
      // and dropped the remote fields, so a customer following the documented
      // `plur init-remote` onboarding got memory on Claude Code and silence
      // here. The helper carries #1196's trust gate with the capability, so
      // adding it cannot reintroduce the exfiltration path.
      const projectRemote = resolveProjectRemote(plur, dir)
      const { scope } = sessionSettings(policy, projectRemote.config)
      const injectOpts = {
        budget: 2000,
        ...(scope ? { scope } : {}),
        ...(projectRemote.remoteProject ? { remote_project: projectRemote.remoteProject } : {}),
      }

      const { result, mode } = await injectWithFallback(plur, prompt, injectOpts)
      recordInjected('codex', sessionId, result.injected_ids) // #1310 auto-rate

      const body = [result.directives, result.constraints, result.consider].filter(Boolean).join('\n')
      // A refusal is emitted even with nothing recalled: silence is exactly the
      // failure mode this is meant to end — once per session, not per prompt.
      const notices = !firstForSession ? [] : [
        projectRemote.refusedFrom ? projectRemoteRefusalNotice(projectRemote.refusedFrom, plur.storageRoot) : null,
      ].filter((n): n is string => n !== null)
      if (result.count === 0 || !body) {
        if (notices.length > 0) emitContext('UserPromptSubmit', notices.join('\n'))
        return
      }

      const notice = notices.length > 0 ? `${notices.join('\n')}\n\n` : ''
      emitContext(
        'UserPromptSubmit',
        `${notice}[PLUR Memory — ${result.count} engrams recalled for this prompt via ${mode}]\n\n${body}`,
      )
    } catch (err: unknown) {
      // Diagnostics go to stderr: Codex parses stdout as the hook result, and
      // a non-JSON byte there would invalidate the whole output.
      process.stderr.write(`[plur] codex inject failed: ${(err as Error)?.message ?? 'unknown error'}\n`)
    }
  })
}
