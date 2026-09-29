import { appendFileSync, readFileSync, openSync, fstatSync, readSync, closeSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  rateInjectedEngrams,
  extractSelfReportedLearnings,
  readProjectConfig,
  bareEngramId,
  type RatedEngram,
} from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { safeSessionKey } from './session-key.js'
import { ensureSessionDir, sessionDirSafeToSweep, cleanupStaleSessionFiles } from './codex-hook-io.js'

/**
 * Automatic rating of injected engrams at the end of a turn (#1310), shared by
 * every editor's end-of-turn hook (`plur hook-auto-rate --editor <name>`).
 *
 * Two halves:
 *
 * 1. The inject hooks call {@link recordInjected} with the ids they injected,
 *    keyed by (editor, the editor's own session id). Only ids are stored —
 *    never engram text — in a vetted per-user directory (the same checks the
 *    Codex/Cursor/Antigravity session dirs get, #1060).
 * 2. The end-of-turn hook calls {@link autoRateTurn} with the reply text. Ids
 *    injected this session and not yet rated are loaded, rated against the
 *    reply by core's `rateInjectedEngrams`, and every verdict at or above 0.6
 *    is sent as `source: 'auto'` feedback — ranking only, never commitment.
 *    Each engram gets at most one automatic verdict per session: a rated id is
 *    recorded and not rated again, so one engram quoted in every reply of a
 *    long session is not pushed up on every turn.
 *
 * Fast path: when nothing was injected this session (or everything injected
 * has been rated) and auto-capture is off, no store is opened at all — the
 * cost is one small file read.
 *
 * Switches (environment, the same convention as PLUR_REMOTE_RECALL):
 *   PLUR_AUTO_RATE=0|false|off   turns automatic rating off (on by default)
 *   PLUR_AUTO_CAPTURE=1|true|on  turns automatic capture on (off by default)
 */

export type AutoRateEditor = 'claude' | 'codex' | 'cursor' | 'agy'

const DIR = join(tmpdir(), 'plur-auto-rate')

/** Test seam — where the per-session id lists live. */
export function autoRateDir(): string {
  return DIR
}

export function autoRateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PLUR_AUTO_RATE ?? '').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off')
}

export function autoCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PLUR_AUTO_CAPTURE ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on'
}

function fileFor(editor: AutoRateEditor, sessionId: string, kind: 'injected' | 'rated'): string {
  return join(DIR, `${editor}-${safeSessionKey(sessionId)}.${kind}`)
}

function readIds(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * One id per line, appended: each line is far below PIPE_BUF, so concurrent
 * hooks (Claude Code runs async hooks in parallel) cannot tear each other's
 * writes. Fail-open: a hook must never break because this bookkeeping could
 * not be written — the only cost is that the turn is not rated.
 */
function appendIds(path: string, ids: string[]): void {
  if (ids.length === 0) return
  if (!ensureSessionDir(DIR)) return
  try { appendFileSync(path, ids.join('\n') + '\n', { mode: 0o600 }) } catch { /* fail-open */ }
}

/** Record the ids an inject hook just delivered for this editor session. */
export function recordInjected(editor: AutoRateEditor, sessionId: unknown, ids: unknown): void {
  try {
    if (!autoRateEnabled()) return
    if (typeof sessionId !== 'string' || !sessionId) return
    if (!Array.isArray(ids)) return
    const clean = ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && !/\s/.test(id))
    appendIds(fileFor(editor, sessionId, 'injected'), clean)
  } catch { /* fail-open */ }
}

/** Ids injected in this session that have not had an automatic verdict yet. */
export function pendingInjected(editor: AutoRateEditor, sessionId: string): string[] {
  const rated = new Set(readIds(fileFor(editor, sessionId, 'rated')))
  return [...new Set(readIds(fileFor(editor, sessionId, 'injected')))].filter(id => !rated.has(id))
}

export interface AutoRateOutcome {
  /** Verdicts that were applied. */
  rated: RatedEngram[]
  /** Statements written by auto-capture (0 unless PLUR_AUTO_CAPTURE opts in). */
  captured: number
}

/**
 * Rate this session's injected engrams against one reply, and — only when
 * opted in — capture the reply's self-reported learnings. Never throws.
 */
export async function autoRateTurn(opts: {
  editor: AutoRateEditor
  sessionId: string
  reply: string
  flags: GlobalFlags
  /** Project root for `.plur.yaml` scope/domain on captured learnings. */
  cwd?: string
}): Promise<AutoRateOutcome> {
  const outcome: AutoRateOutcome = { rated: [], captured: 0 }
  try {
    const reply = typeof opts.reply === 'string' ? opts.reply : ''
    if (!reply.trim() || !opts.sessionId) return outcome

    const pending = autoRateEnabled() ? pendingInjected(opts.editor, opts.sessionId) : []
    const capture = autoCaptureEnabled()
    if (pending.length === 0 && !capture) return outcome // nothing injected, nothing to do

    const plur = createPlur(opts.flags)

    if (pending.length > 0) {
      const engrams = await plur.getByIds(pending)
      // One record can be injected under two ids — its own and a store-
      // namespaced alias (ENG-XYZ-…) when the same file is also mounted as a
      // secondary store. Rate each record once: same bare id and statement
      // means same engram, and rating both would count one reply twice.
      const seen = new Set<string>()
      const unique = engrams.filter(e => {
        const k = `${bareEngramId(e.id)}\u0000${e.statement}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      const verdicts = rateInjectedEngrams(
        unique.map(e => ({ id: e.id, statement: e.statement })),
        reply,
      )
      const done: string[] = []
      for (const v of verdicts) {
        try {
          await plur.feedback(v.id, v.signal, undefined, { source: 'auto' })
          outcome.rated.push(v)
        } catch (err) {
          process.stderr.write(`[plur] auto-rate: ${v.id} not rated (${(err as Error)?.message ?? 'unknown'})\n`)
        }
        // Rated or refused (remote, readonly): either way, do not retry it
        // on every later turn of this session.
        done.push(v.id)
      }
      // Aliases skipped above, and ids that no longer exist anywhere, will
      // never be rated on their own; stop loading them.
      const kept = new Set(unique.map(e => e.id))
      for (const id of pending) if (!kept.has(id)) done.push(id)
      appendIds(fileFor(opts.editor, opts.sessionId, 'rated'), done)
    }

    // `auto_learn: false` in config.yaml is the store-wide kill switch for
    // automatic writes (the opencode plugin honours it the same way).
    if (capture && (plur as unknown as { config?: { auto_learn?: boolean } }).config?.auto_learn !== false) {
      const statements = extractSelfReportedLearnings({ role: 'assistant', content: reply })
      if (statements.length > 0) {
        const project = readProjectConfig(opts.cwd)
        for (const statement of statements) {
          try {
            await plur.learnRouted(statement, {
              type: 'behavioral',
              ...(project.scope ? { scope: project.scope } : {}),
              ...(project.domain ? { domain: project.domain } : {}),
              source: `${opts.editor}:auto-capture`,
              rationale: 'self-reported by the agent in its reply (auto-capture)',
              tags: ['auto-capture'],
              claim_class: 'inferred',
            })
            outcome.captured++
          } catch (err) {
            process.stderr.write(`[plur] auto-capture: not stored (${(err as Error)?.message ?? 'unknown'})\n`)
          }
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[plur] auto-rate failed: ${(err as Error)?.message ?? 'unknown'}\n`)
  }
  sweep()
  return outcome
}

let swept = false
function sweep(): void {
  if (swept) return
  swept = true
  if (sessionDirSafeToSweep(DIR)) cleanupStaleSessionFiles(Date.now(), DIR)
}

/**
 * Antigravity's Stop payload carries no reply text, so read it from the
 * transcript the payload points at: every MODEL `PLANNER_RESPONSE` step with
 * text content after the last USER_INPUT step, joined. Format observed on
 * agy 1.1.22; like `lastUserInput`, any read or parse failure is "no reply",
 * never an error. Reads at most the trailing 4MB.
 */
export function agyReplySinceLastUser(transcriptPath: string): string {
  const CAP = 4 * 1024 * 1024
  let raw = ''
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return ''
    const fd = openSync(transcriptPath, 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(size, CAP)
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, size - len)
      raw = buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
  let parts: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line) as { type?: string; source?: string; content?: unknown }
      if (d.type === 'USER_INPUT') { parts = []; continue }
      if (d.source === 'MODEL' && d.type === 'PLANNER_RESPONSE' && typeof d.content === 'string' && d.content.trim()) {
        parts.push(d.content)
      }
    } catch { /* torn line — skip */ }
  }
  return parts.join('\n')
}
