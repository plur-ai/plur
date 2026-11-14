import { skippedStoreNotice } from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { hookFolderPolicy, sessionSettings, folderAskOnce, untrustedPlurYamlAsk, createAskPlur, bindHookFolder, remoteOnlyLines } from '../lib/folder-gate.js'
import type { FolderPolicy } from '@plur-ai/core'
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
import { resolveProjectRemote, projectRemoteRefusalNotice } from '../lib/project-remote.js'
import { recordInjected } from '../lib/auto-rate.js'

/**
 * plur hook-agy-pre-invocation — Antigravity `PreInvocation` hook; session batch, recall
 * and the learn nudge all ride here. The prompt is read from `transcriptPath` (unreadable
 * → generic batch). It fires before EVERY invocation and ephemerals last one, so the
 * turn's message is cached and replayed; turn identity is (step_index, text hash).
 * No isPlurConfigured() gate (cwd is ~/.gemini/config): the install is the opt-in, and
 * a named workspace follows the folder map (off silent, ask once per turn).
 * Input: camelCase JSON { conversationId, invocationNum, transcriptPath, workspacePaths, ... }
 * Output: {"injectSteps":[{"ephemeralMessage": "..."}]} or nothing.
 */

const TURNS_BETWEEN_NUDGES = 6

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  await runAgyHook('agy pre-invocation', async () => {
    const input = readStdinJson()

    const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths as string[] : []
    const workspace = (workspaces.length > 0 && typeof workspaces[0] === 'string') ? workspaces[0] : null
    // No workspace: the install is the opt-in (no folder to ask about).
    const policy: FolderPolicy | null = workspace ? hookFolderPolicy(workspace, flags) : null
    if (policy?.mode === 'off') return

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
    // memory.
    const rawCached = readAgyTurnCache(conversationId)
    // Replayed only under the same folder decision: never when the map cannot
    // be read, and in a remote-only folder only a message cached there for the
    // same team scope (one cached under another mode may hold personal memory).
    const unresolved = policy?.reason === 'malformed-map' || policy?.reason === 'resolver-error'
    const cached = rawCached && (unresolved ||
      (policy?.mode === 'remote-only' && (rawCached.mode !== 'remote-only' || rawCached.scope !== policy.scope))) ? null : rawCached

    // "First" is the conversation's first turn. The absence of a cache alone
    // cannot say that: with an unusable cache dir it is absent on EVERY turn,
    // and every turn would get the session-start header, budget and refusal
    // notice. When the transcript is readable it decides.
    const isFirst = cached === null && Number(input.invocationNum ?? 0) === 0 &&
      (user === null || user.firstInTranscript)
    // `cached === null` counts as a new turn when a user message exists: it
    // covers both the genuine first turn and the fail-open path where the
    // cache dir is unusable (writeAgyTurnCache no-ops). In the latter case
    // every invocation re-recalls — slow, but memory keeps flowing, which is
    // the right direction to degrade.
    // The line offset separates two identical messages when step_index is
    // missing (both -1), so the stale memory is not replayed.
    const isNewTurn = user !== null &&
      (cached === null || user.stepIndex > cached.step || userHash !== cached.textHash ||
        (cached.offset !== undefined && user.offset !== cached.offset))
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

    if (workspace && policy?.mode === 'ask') {
      // The question, once per conversation; an empty message after that. It
      // is cached as this turn's message so mid-turn invocations replay it.
      // No store discovery: asking must not register this folder's .plur store.
      const ask = folderAskOnce({ dir: workspace, policy, sessionId: conversationId, flags, plur: createAskPlur(flags), prompt: user?.text ?? '' }) ?? ''
      writeAgyTurnCache({ conversationId, step: user?.stepIndex ?? 0, textHash: userHash, message: ask })
      if (ask) emitInjectSteps(ask)
      return
    }

    agyMarkSessionStarted(conversationId)

    const plur = createPlur(flags)
    if (workspace && policy) bindHookFolder(plur, workspace, policy)
    // The workspace path, not process.cwd(): agy runs hooks with cwd = the
    // hooks.json directory (~/.gemini/config), where the .plur.yaml walk can
    // never succeed — cwd here would silently strip project scoping from
    // every agy recall AND from the scope line the model is told to learn
    // under. The project's remote settings are passed so team memory reaches
    // Antigravity; the helper applies the trust gate with the capability.
    const projectRemote = resolveProjectRemote(plur, workspace ?? process.cwd())
    // With a workspace, the session scope is the folder policy's.
    const projectConfig = policy ? sessionSettings(policy, projectRemote.config) : projectRemote.config
    const injectOpts = {
      budget: isFirst ? 3000 : 2000,
      ...(projectConfig.scope ? { scope: projectConfig.scope } : {}),
      ...(projectRemote.remoteProject ? { remote_project: projectRemote.remoteProject } : {}),
    }
    const task = user?.text ?? 'general session start'

    let message: string
    try {
      const { result, mode } = await injectWithFallback(plur, task, injectOpts)
      recordInjected('agy', conversationId, result.injected_ids)
      const body = result.count > 0
        ? [result.directives, result.constraints, result.consider].filter(Boolean).join('\n')
        : ''
      const header = isFirst
        ? [
          `[PLUR Memory — session started, ${result.count} engrams injected via ${mode}]` +
            (projectConfig.scope && !plur.remoteOnlyFolder() ? `\nProject scope: ${projectConfig.scope} — use this scope for plur_learn calls` : ''),
          // remote-only: where memory goes, and that the team server did not answer.
          ...remoteOnlyLines(plur, result, true),
        ].join('\n')
        : `[PLUR Memory — ${result.count} engrams recalled for this prompt via ${mode}]`
      const refusal = isFirst
        ? [
          projectRemote.refusedFrom ? projectRemoteRefusalNotice(projectRemote.refusedFrom, plur.storageRoot) : null,
        ].filter(Boolean).map(n => `${n}\n\n`).join('')
        : ''
      // Only on the FIRST turn: the refusal persists until the user acts on it,
      // so repeating it every turn would be noise rather than information.
      message = refusal + (body ? `${header}\n\n${body}` : (isFirst ? header : ''))
      // A store in the workspace that was found but not added: once
      // per conversation and workspace folder.
      const hint = workspace ? skippedStoreNotice(plur, conversationId, workspace) : null
      if (hint) message = message ? `${hint}\n${message}` : hint
      // An untrusted .plur.yaml: memories load without its settings, and the
      // trust question rides along once per conversation (owner, 2026-11-14).
      // Cached with this turn's message, so mid-turn invocations replay it.
      const trustAsk = workspace && policy
        ? untrustedPlurYamlAsk({ dir: workspace, policy, sessionId: conversationId, flags, plur, prompt: user?.text ?? '' })
        : null
      if (trustAsk) message = message ? `${message}\n\n${trustAsk}` : trustAsk
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
    // would make every mid-turn invocation re-run a full recall. A failed
    // write degrades to exactly that, which is the acceptable direction.
    writeAgyTurnCache({
      conversationId,
      step: user?.stepIndex ?? 0,
      textHash: userHash,
      message,
      ...(user ? { offset: user.offset } : {}),
      ...(policy ? { mode: policy.mode, ...(policy.scope ? { scope: policy.scope } : {}) } : {}),
    })

    if (!message) return

    emitInjectSteps(message)
  })
}
