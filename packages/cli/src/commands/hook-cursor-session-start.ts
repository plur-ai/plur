import { skippedStoreNotice } from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { cursorHookFolder, sessionSettings, folderAskOnce, isFolderAskText, createAskPlur, bindHookFolder, remoteOnlyLines } from '../lib/folder-gate.js'
import { cursorContextRulePath } from '../mcp-config.js'
import { readStdinJson, cursorConversationId, markSessionStarted, writeContextRule, removeGeneratedContextRules } from '../lib/cursor-hook-io.js'
import { resolveProjectRemote, projectRemoteRefusalNotice } from '../lib/project-remote.js'
import { recordInjected } from '../lib/auto-rate.js'
import { recordHookRun } from '../lib/hook-runs.js'
import { cachedServerLines } from '../lib/server-session.js'
import { cleanupLegacyProjectAtSessionStart } from '../lib/legacy-plur-yaml.js'

/**
 * plur hook-cursor-session-start — Cursor `sessionStart` hook (fire-and-forget
 * on Cursor's side, so it gates nothing). Writes the sentinel hook-cursor-guard
 * checks, and recalled engrams into `.cursor/rules/plur-context.mdc` via
 * `writeContextRule()` (primary: Cursor can drop `additional_context` in a
 * race); also emits `{ additional_context }` on stdout.
 * BM25-only, deliberately: the hook must BE fast and hybrid's cold embedder load
 * is far too slow. Do not change this to try hybrid first. Not fired for
 * background/cloud agents; hook-cursor-post-tool covers those.
 */

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const input = readStdinJson()

  // The folder map decides. off is silent; ask puts the one question where
  // Cursor reads it (the rule file, plus additional_context) instead of
  // memories, and marks nothing, so the guard stays silent too.
  // The folder is the workspace (workspace_roots), not this process's folder
  // — the same decision every Cursor hook reaches, see cursorHookFolder.
  const { dir, policy, askAbout, cleanupDirs } = cursorHookFolder(input, flags)
  if (policy.mode === 'off') {
    for (const root of cleanupDirs ?? (dir ? [dir] : [])) removeGeneratedContextRules(root)
    return
  }
  recordHookRun('cursor', flags.path)
  if (dir && policy.mode === 'ask') removeStaleAsk(cursorContextRulePath(dir))
  // remote-only (also an `ask` workspace with a remote-only root): another
  // root's generated rule may hold personal memory from an earlier session;
  // this session writes its own rule in `dir` only.
  // Every root, `dir` included, before any early return: the fresh rule is
  // written below only when the session goes on.
  if (policy.mode === 'remote-only' || (policy.mode === 'ask' && cleanupDirs)) {
    for (const root of new Set([...(cleanupDirs ?? []), ...(dir ? [dir] : [])])) removeGeneratedContextRules(root)
  }

  const conversationId = cursorConversationId(input)
  if (!conversationId) return // can't track this session — stay silent rather than guess

  if (policy.mode === 'ask') {
    // The question is about `askAbout` when that root does not exist: shown
    // from `dir`, the first root that does, and
    // only in additional_context when none does — never by creating it.
    const about = askAbout ?? dir
    if (!about) return
    // No store discovery: asking must not register this folder's .plur store.
    const ask = folderAskOnce({ dir: about, policy, sessionId: conversationId, flags, plur: createAskPlur(flags) })
    if (!ask) return
    if (dir) writeContextRule(ask, cursorContextRulePath(dir))
    process.stdout.write(JSON.stringify({ additional_context: ask }))
    return
  }
  if (!dir) return
  const rulePath = cursorContextRulePath(dir)

  // markSessionStarted (not a bare sentinel write) so the reminder timer also
  // resets here — otherwise hook-cursor-post-tool's isReminderDue() sees no
  // lastReminderPath yet and fires a reminder on the very next tool call,
  // seconds after the session just started.
  markSessionStarted(conversationId)

  // Guarded: markSessionStarted() has already run, so if inject() threw
  // unguarded the guard would stop enforcing while the rule file silently
  // kept a PREVIOUS session's content. A failure writes an explicit notice
  // instead.
  let fullContext: string
  try {
    const plur = createPlur(flags)
    // remote-only: core reads only the team scope (dialled, even from this
    // keyword-only inject) and packs, never the personal store.
    bindHookFolder(plur, dir, policy)
    const legacyLines = cleanupLegacyProjectAtSessionStart(dir, plur.storageRoot)
    const projectRemote = resolveProjectRemote(plur, dir)
    const projectConfig = sessionSettings(policy, projectRemote.config)
    const injectOpts = { budget: 3000, ...(projectConfig.scope ? { scope: projectConfig.scope } : {}) }

    // NOT hybrid, and therefore NOT remote — see the BM25-only note in this
    // file's header. This hook is bounded at 10s, and hybrid loads the BGE
    // embedder (~20s cold on a few thousand engrams).
    //
    // Consequence: PLUR Enterprise team memory does NOT reach Cursor here.
    // The remote leg rides inside injectHybrid, so the only path to it also
    // loads the local embedder. The remote leg itself does not need the
    // embedder (it sends query TEXT and the server embeds), so a
    // remote-with-BM25 mode in core would lift this without touching the
    // deadline.
    const result = await plur.inject('general session start', injectOpts)
    recordInjected('cursor', conversationId, result.injected_ids) // for auto-rate
    const count = result.count
    const context = count > 0 ? [result.directives, result.constraints, result.consider].filter(Boolean).join('\n') : ''

    // A store in the workspace that was found but not added: once per
    // conversation and workspace folder (the payload's root, not this process's).
    const hint = skippedStoreNotice(plur, conversationId, dir)
    const header = [
      `[PLUR Memory — session started, ${count} engrams injected]` +
        (projectConfig.scope && !plur.remoteOnlyFolder() ? `\nProject scope: ${projectConfig.scope} — use this scope for plur_learn calls` : '') +
        (hint ? `\n${hint}` : ''),
      // remote-only: where memory goes, and that the team server did not answer.
      ...remoteOnlyLines(plur, result, true),
      ...await cachedServerLines(plur, dir, policy),
      ...legacyLines,
    ].join('\n')

    // A refused .plur.yaml is still worth saying: the user's scope routing is
    // unaffected, but they should know the remote settings were not honoured —
    // for the trust reason here, and because remote memory does not reach
    // this hook regardless.
    const refusal = [
      projectRemote.refusedFrom ? projectRemoteRefusalNotice(projectRemote.refusedFrom, plur.storageRoot) : null,
    ].filter(Boolean).map(n => `${n}\n\n`).join('')
    fullContext = refusal + (context ? `${header}\n\n${context}` : header)
  } catch (err: unknown) {
    // Names the CLI `plur doctor`, not the `plur_doctor` MCP tool: the tool
    // only covers embedder/remote-store health, not .cursor/mcp.json or
    // .cursor/hooks.json wiring, which is the likelier cause of a failure
    // here.
    fullContext = '[PLUR Memory — injection FAILED this session start] ' +
      `(${(err as Error).message ?? 'unknown error'}). Recalled memory is unavailable; run ` +
      '`plur doctor` in a TERMINAL (the CLI command — checks .cursor/ wiring; ' +
      'the plur_doctor MCP tool only checks the embedder/remote-store, not this) to diagnose.'
  }

  // Primary channel — always write, even at count 0 or on failure, so the
  // rule file reflects THIS session's real state rather than going stale
  // from a previous session's content.
  writeContextRule(fullContext, rulePath)

  // Secondary channel — harmless if broken, free upgrade if Cursor fixes it.
  process.stdout.write(JSON.stringify({ additional_context: fullContext }))
}

/**
 * A question an earlier session left in the rule file must not outlive the
 * decision: Cursor loads the file into every new conversation. Removed when
 * the folder is not `on` (an `ask` session writes a fresh one). Only a file
 * holding our own question is touched.
 */
function removeStaleAsk(rulePath: string): void {
  try {
    if (existsSync(rulePath) && isFolderAskText(readFileSync(rulePath, 'utf8'))) unlinkSync(rulePath)
  } catch { /* best-effort */ }
}
