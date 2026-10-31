import { skippedStoreNotice } from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { hookFolderPolicy, payloadDir, sessionSettings, folderAskOnce, createAskPlur, bindHookFolder, remoteOnlyLines } from '../lib/folder-gate.js'
import { readStdinJson, runCodexHook, codexSessionId, markSessionStarted, isSessionStarted, emitContext, injectWithFallback } from '../lib/codex-hook-io.js'
import { resolveProjectRemote, projectRemoteRefusalNotice } from '../lib/project-remote.js'
import { recordInjected } from '../lib/auto-rate.js'

/**
 * plur hook-codex-inject — Codex `UserPromptSubmit` hook: recalls engrams for THIS prompt
 * and returns them as `additionalContext`. Synchronous (async context would land on the
 * next turn), hybrid-first with a BM25 fallback — see `injectWithFallback`.
 * Also marks the session sentinel, since resumed/forked sessions may skip SessionStart.
 * Input: JSON on stdin { session_id, turn_id, cwd, hook_event_name, prompt, ... }.
 * Output: { hookSpecificOutput: { hookEventName, additionalContext } } or nothing.
 */
export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  await runCodexHook('codex inject', async () => {
    const input = readStdinJson()
    const sessionId = codexSessionId(input)
    const prompt = String(input.prompt ?? '').trim()

    // Off is silent; ask prints the one question on the first prompt
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
    // context, not every prompt: SessionStart says them,
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
      bindHookFolder(plur, dir, policy)
      // Pass the project's remote settings (from `.plur.yaml`, as written by
      // `plur init-remote`) so team memory reaches Codex. The helper applies
      // the trust gate together with the capability, so an untrusted project
      // file cannot point recall at a remote store.
      const projectRemote = resolveProjectRemote(plur, dir)
      const { scope } = sessionSettings(policy, projectRemote.config)
      const injectOpts = {
        budget: 2000,
        ...(scope ? { scope } : {}),
        ...(projectRemote.remoteProject ? { remote_project: projectRemote.remoteProject } : {}),
      }

      const { result, mode } = await injectWithFallback(plur, prompt, injectOpts)
      recordInjected('codex', sessionId, result.injected_ids) // auto-rate

      const body = [result.directives, result.constraints, result.consider].filter(Boolean).join('\n')
      // A refusal is emitted even with nothing recalled: silence is exactly the
      // failure mode this is meant to end — once per session, not per prompt.
      const notices = [
        firstForSession && projectRemote.refusedFrom ? projectRemoteRefusalNotice(projectRemote.refusedFrom, plur.storageRoot) : null,
        // A store here that was found but not added: once per session and folder.
        sessionId ? skippedStoreNotice(plur, sessionId, dir) : null,
        // remote-only: where memory goes, and that the team server did not answer
        // (first prompt of the session only).
        ...remoteOnlyLines(plur, result, firstForSession),
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
