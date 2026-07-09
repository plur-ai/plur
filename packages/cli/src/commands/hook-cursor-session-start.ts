import { createPlur, type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import { readStdinJson, cursorConversationId, markSessionStarted, writeContextRule } from '../lib/cursor-hook-io.js'
import { readProjectConfig } from '@plur-ai/core'

/**
 * plur hook-cursor-session-start — Cursor `sessionStart` hook.
 *
 * Fires once when a new composer conversation is created. Cursor's own docs
 * describe this as fire-and-forget — "session creation is not blocked even
 * when continue is false" — so nothing here can gate anything; it only
 * writes the sentinel hook-cursor-guard checks and delivers an initial batch
 * of recalled engrams.
 *
 * Delivery mechanism (audit fix, live-evidence version — see Global
 * Constraints): Cursor's own team confirmed on their forum that
 * `additional_context` from `sessionStart` is dropped by a race condition
 * ("runs async before the composer handle is fully created") — filed,
 * acknowledged, no fix timeline. This hook writes recalled content into the
 * DYNAMIC rules file via `writeContextRule()` as the PRIMARY channel
 * (Cursor's rules engine reliably loads `alwaysApply: true` rules AT
 * CONVERSATION CREATION — this is the community-and-team-confirmed
 * workaround), and still ALSO emits `additional_context` (harmless, and
 * picks up automatically for free if Cursor ships a fix later). Whether a
 * later REWRITE of this same file is re-read before the conversation ends
 * is not independently confirmed — see writeContextRule's docstring and
 * cursor-hook-io.ts's "Known structural limitations" item 4.
 *
 * BM25-only, deliberately (PR #502's lesson, ported from hook-inject.ts's
 * --event branch — see Global Constraints). Cursor's hook schema has no
 * documented async/fire-and-forget option the way Claude Code's
 * UserPromptSubmit now has, so this hook has no way to dodge a slow cold
 * start — it has to just BE fast. Hybrid search loads the BGE embedder
 * (~20s cold once the store passes a few thousand engrams, which is exactly
 * the failure PR #502 fixed for Claude Code); BM25 alone measured 0.74s
 * against 4,290 engrams in the same codebase. Do not change this to try
 * hybrid first.
 *
 * Does not fire for background/cloud agents (VM provisioned after prompt
 * submit) — hook-cursor-post-tool covers that path instead, by marking the
 * sentinel when plur_session_start is called explicitly.
 *
 * Input: JSON on stdin — { conversation_id | session_id, is_background_agent, composer_mode }
 * Output: JSON on stdout — { additional_context } (Cursor's sessionStart-specific field, secondary channel)
 * Side effect: writes `.cursor/rules/plur-context.mdc` (primary channel)
 */

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  if (!isPlurConfigured()) return

  const input = readStdinJson()
  const conversationId = cursorConversationId(input)
  if (!conversationId) return // can't track this session — stay silent rather than guess

  // markSessionStarted (not a bare sentinel write) so the reminder timer also
  // resets here — otherwise hook-cursor-post-tool's isReminderDue() sees no
  // lastReminderPath yet and fires a reminder on the very next tool call,
  // seconds after the session just started.
  markSessionStarted(conversationId)

  // Audit fix (evaluator review, 2026-07-08): this used to call inject() and
  // writeContextRule() unguarded, AFTER markSessionStarted() above already
  // ran. If inject() threw, the sentinel would still exist (guard stops
  // enforcing) but the rule file would silently keep a PREVIOUS session's
  // content, with nothing distinguishing "this session's memory, 0 engrams"
  // from "stale leftovers from last time, injection is broken." Wrapping
  // this so a failure writes an explicit, honest notice instead.
  let fullContext: string
  try {
    const plur = createPlur(flags)
    const projectConfig = readProjectConfig()
    const injectOpts = { budget: 3000, ...(projectConfig.scope ? { scope: projectConfig.scope } : {}) }

    const result = plur.inject('general session start', injectOpts)
    const count = result.count
    const context = count > 0 ? [result.directives, result.constraints, result.consider].filter(Boolean).join('\n') : ''

    const header = `[PLUR Memory — session started, ${count} engrams injected]` +
      (projectConfig.scope ? `\nProject scope: ${projectConfig.scope} — use this scope for plur_learn calls` : '')

    fullContext = context ? `${header}\n\n${context}` : header
  } catch (err: unknown) {
    fullContext = '[PLUR Memory — injection FAILED this session start] ' +
      `(${(err as Error).message ?? 'unknown error'}). Recalled memory is unavailable; run ` +
      '`plur doctor` to diagnose.'
  }

  // Primary channel — always write, even at count 0 or on failure, so the
  // rule file reflects THIS session's real state rather than going stale
  // from a previous session's content.
  writeContextRule(fullContext)

  // Secondary channel — harmless if broken, free upgrade if Cursor fixes it.
  process.stdout.write(JSON.stringify({ additional_context: fullContext }))
}
