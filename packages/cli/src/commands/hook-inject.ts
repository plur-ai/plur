import { existsSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, readSync, statSync, readdirSync, unlinkSync, renameSync, openSync, closeSync, linkSync, writeSync, fstatSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir, hostname, setPriority } from 'os'
import { spawn } from 'child_process'
import { randomUUID, randomBytes } from 'crypto'
import { createPlur, type GlobalFlags } from '../plur.js'
import { cleanupStaleSessionFiles } from '../lib/codex-hook-io.js'
import { checkpointRoot } from './hook-learn-check.js'
import { hookFolderPolicy, payloadDir, sessionSettings, folderAskOnce, createAskPlur, bindHookFolder, remoteOnlyLines } from '../lib/folder-gate.js'
import type { FolderPolicy } from '@plur-ai/core'
import { safeSessionKey } from '../lib/session-key.js'
import { injectWithFallback, hybridEnabled, type Injectable, type InjectOutcome } from '../lib/codex-hook-io.js'
import { waitForOwnStoreLock, exitWhenStoreIdle, EXIT_LOCK_WAIT_MS } from '../lib/store-lock-exit.js'
import { correctionReminder } from './hook-correction-detect.js'
import { recordInjected } from '../lib/auto-rate.js'
import { hookSessionDir, readSessionTask, writeSessionTask } from '../lib/session-task.js'

// Remote budget for the recall leg inside injectHybrid (#776). The hook is
// on the hot path of every prompt; slow networks make this a perceptible
// latency tax (Taleb #4). 1500ms is the trade-off: long enough for healthy
// remote round trips, short enough to be invisible when the network is fine.
// The leg runs in PARALLEL with the local pipeline, so effective added
// latency is max(0, remote − local). PLUR_REMOTE_RECALL_TIMEOUT_MS overrides.
const REMOTE_TIMEOUT_MS = 1500

// Failure-log dir. The remote recall leg is fail-open by design (it MUST
// never block the user's prompt) — but silent fail-open is unfalsifiable
// (Taleb #2): you cannot distinguish "Enterprise is working but had no
// engrams for this query" from "Enterprise is unreachable and we
// silently degraded to local." Each per-host recall outcome writes ONE
// JSON LINE.
//
// File-per-day rotation avoids the truncation race the earlier size-
// based scheme had (dijkstra DEF-1): two concurrent hooks could both
// observe "over cap" and both truncate, the second wiping the first's
// entry. POSIX guarantees that appendFileSync (O_APPEND) writes smaller
// than PIPE_BUF (4KB on Linux) are atomic, so concurrent appends to
// the same day-file are safe. Cleanup of old day-files is a follow-up
// (plur doctor can list/prune them).
const REMOTE_INJECT_LOG_DIR = join(homedir(), '.plur', 'logs')
function remoteInjectLogPath(): string {
  return join(REMOTE_INJECT_LOG_DIR, `remote-inject-${new Date().toISOString().slice(0, 10)}.jsonl`)
}

function logRemoteAttempt(entry: {
  ts:        string
  url:       string
  // #776: the recall leg's per-host states join the legacy outcome values so
  // old log tooling keeps parsing the same field.
  outcome:   'ok' | 'http_error' | 'timeout' | 'network_error' | 'bad_response' | 'oversize'
           | 'unreachable' | 'auth_expired' | 'forbidden' | 'rate_limited' | 'unsupported' | 'skipped_cooldown'
  ms:        number
  http?:     number
  engrams?:  number
  detail?:   string
}): void {
  try {
    mkdirSync(REMOTE_INJECT_LOG_DIR, { recursive: true })
    // O_APPEND under POSIX guarantees atomic writes < PIPE_BUF.
    // The serialized entry is well under that, so concurrent hooks
    // never tear each other's lines or wipe history.
    appendFileSync(remoteInjectLogPath(), JSON.stringify(entry) + '\n')
  } catch {
    // Log write failed — accept silently. The hook MUST never throw.
  }
}

/**
 * plur hook-inject — Claude Code hook for engram injection + auto session start.
 *
 * Called by UserPromptSubmit hook. First call:
 *   1. Creates a session ID (auto session start — no need for explicit plur_session_start)
 *   2. Reads .plur.yaml for project-level domain/scope defaults
 *   3. Injects relevant engrams based on the user's prompt
 *
 * Subsequent calls check if a reminder is due (every 10 min).
 *
 * With --rehydrate: always injects (used by the SessionStart hook, matcher
 * "compact", after context compaction to restore engrams that were lost).
 * It was registered on PostCompact until #1274; PostCompact cannot carry
 * context in Claude Code, so a stale PostCompact registration prints nothing.
 *
 * With --event <type>: contextual injection for specific tool events:
 *   --event plan_mode   Full engram injection when entering plan mode
 *   --event skill       Domain-specific engrams based on skill name
 *   --event agent       Agent-scoped engrams for spawned agent
 *   --event subagent    Inject agent-scoped engrams into subagent context
 *
 * Input: JSON on stdin (Claude Code hook format: {prompt, ...} or {compact_summary, ...})
 * Output: JSON on stdout —
 *   {hookSpecificOutput: {hookEventName, additionalContext}} — or empty (exit 0)
 */

/**
 * #1274: Claude Code only hands a hook's context to the model when it is
 * wrapped in `hookSpecificOutput` with a `hookEventName` naming the event that
 * fired. A top-level `{additionalContext}` is recorded as plain hook stdout and
 * never reaches the model — which is how every injection from this hook was
 * being dropped. Same class as the Stop nudge (#1266).
 *
 * The event name comes from the payload's `hook_event_name` when present (it
 * is, by definition, the event that fired); otherwise from how the hook was
 * invoked, matching the registrations `plur init` writes.
 */
function claudeHookEventName(
  input: Record<string, unknown>,
  opts: { rehydrate: boolean; event: string | null },
): string {
  const fromPayload = input.hook_event_name
  if (typeof fromPayload === 'string' && fromPayload.length > 0) return fromPayload
  if (opts.rehydrate) return 'SessionStart' // matcher "compact" (#1274)
  if (opts.event === 'subagent') return 'SubagentStart'
  if (opts.event) return 'PreToolUse' // plan_mode | skill | agent
  return 'UserPromptSubmit'
}

/**
 * Events whose hook output cannot carry model-visible context. Claude Code
 * 2.1.284 rejects `hookEventName: "PostCompact"` ("Hook JSON output
 * validation failed", shown to the user) and ignores a top-level
 * additionalContext, so printing anything there is noise.
 */
const NO_CONTEXT_EVENTS = new Set(['PostCompact'])

// The last task seen for a Claude Code session, keyed on the payload
// `session_id` (lib/session-task.ts): the SessionStart(compact) payload carries
// no compact_summary, so rehydration queries with it. Rewritten on every
// prompt, length-capped, 0600 in a verified 0700 dir, removed at SessionEnd.

/**
 * #1278: the key for this session's marker, reminder clock and inject lock.
 * The payload `session_id` first, then CLAUDE_SESSION_ID, then ppid — the same
 * precedence as the Stop counter (#1266), sanitised with the shared helper.
 * Claude Code runs every hook in a fresh `/bin/sh -c` and does not export
 * CLAUDE_SESSION_ID, so a ppid key changed on every prompt: the "already
 * started" check never matched, every prompt re-ran the full injection, and
 * the 10-minute reminder never fired. ppid is kept only as the last fallback
 * for callers that send no session id at all.
 */
function sessionKey(input: Record<string, unknown>): string {
  // Owner decision H1 ("payload", 2026-09-29): the one shared helper.
  return hookSessionKey(input.session_id)
}

// Set when the watchdog fires (#1343). The watchdog then waits, bounded, for
// any store write in flight before exiting; the run it stopped must not print
// or mark the session during that wait — a stopped run is a failed attempt.
let stopping = false

/**
 * #1312: the `hook-correction-detect` reminder for this prompt, or null.
 * Folded into this hook's UserPromptSubmit output instead of registering a
 * second process per prompt; only a UserPromptSubmit payload has a prompt.
 */
function promptCorrection(input: Record<string, unknown>): string | null {
  if (claudeHookEventName(input, { rehydrate: false, event: null }) !== 'UserPromptSubmit') return null
  const prompt = input.prompt
  return typeof prompt === 'string' ? correctionReminder(prompt) : null
}

function emitContext(hookEventName: string, additionalContext: string): void {
  if (stopping) return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }))
}

/**
 * emitContext that resolves true once the write has been handed to stdout
 * without error (on macOS a pipe write is asynchronous), false otherwise.
 * The session marker is written only after this resolves true (#1278).
 */
function emitContextConfirmed(hookEventName: string, additionalContext: string): Promise<boolean> {
  if (stopping) return Promise.resolve(false)
  return new Promise(resolvePromise => {
    try {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }),
        err => resolvePromise(!err),
      )
    } catch {
      resolvePromise(false)
    }
  })
}

const REMINDER_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

// Project config (.plur.yaml) reading moved to @plur-ai/core/project-config
// so both this hook AND the MCP server's session_start handler can use it
// (the original duplication was the root cause of #177 — session_start
// ignored .plur.yaml because the reader lived in this CLI-only file).
import { claimHookDegradationLines, type Plur } from '@plur-ai/core'
import { resolveProjectRemote, projectRemoteRefusalNotice, type ProjectRemote } from '../lib/project-remote.js'
import { hookSessionKey } from '../lib/session-key.js' // decision H1

/**
 * #776: the former `tryRemoteInject` remote-first POST /api/v1/inject path
 * is REPLACED by the recall leg inside `injectHybrid` — the core dials each
 * relevant host once (POST /api/v1/recall) in parallel with local search and
 * merges the rows, so a prompt costs AT MOST ONE remote call per host (a
 * degraded host must not cost two sequential remote budgets per prompt).
 * The `.plur.yaml` `remote_url`/`remote_token` is passed through as
 * `remote_project`: project config wins for the hook path — its presence IS
 * the org context for dialing. Per-host outcomes land in the JSONL log below
 * and, on state change, as ONE degradation header line via
 * `claimHookDegradationLines` (suppression persisted in remote-health.json).
 */
function surfaceRemoteOutcomes(plur: Plur): string[] {
  try {
    const outcomes = plur.remoteStoreStatus()
    if (outcomes.length === 0) return []
    for (const o of outcomes) {
      logRemoteAttempt({
        ts: new Date().toISOString(),
        url: o.host,
        outcome: o.status,
        ms: o.ms ?? 0,
        engrams: o.count ?? 0,
      })
    }
    return claimHookDegradationLines(outcomes, { statePath: plur.remoteHealthStatePath() })
  } catch {
    return [] // surfacing must never break the prompt
  }
}

function sessionDir(): string | null {
  // 0700, owned by this user, never a symlink; a refused shared dir falls back
  // to a private one, and null when both are refused (lib/session-task.ts).
  // Null means persist nothing — never write elsewhere. Fail-open: state
  // writes are individually wrapped and the prompt is never broken.
  return hookSessionDir()
}

/**
 * Which Claude Code session is this? (formal r2, cli#7)
 *
 * Every Claude Code hook payload carries `session_id`. The marker used to be
 * keyed by `process.ppid` alone, while the session guard keys by session_id:
 * `/clear` starts a new session in the SAME process, and a recycled PID is a
 * new process with an old number — both found the previous session's marker
 * and skipped injection entirely. The payload id is the identity; ppid is the
 * fallback for payloads without one (and keeps those paths byte-identical to
 * before). The `sid-` prefix keeps the two key spaces disjoint.
 *
 * LEGACY since owner decision H1 ("payload", 2026-09-29): the hook keys its
 * state with `hookSessionKey` (lib/session-key.ts). This is the key a pre-H1
 * writer used — `legacyHookSessionKeys` produces it for readers — kept for
 * its unit tests. Nothing writes under it.
 */
export function injectSessionKey(input: Record<string, unknown>, ppid: number | string = process.ppid || 'unknown'): string {
  const sid = typeof input.session_id === 'string' ? input.session_id : ''
  return sid ? `sid-${safeSessionKey(sid)}` : String(ppid)
}

function sessionStatePath(key: string, ext: string): string | null {
  const dir = sessionDir()
  return dir ? join(dir, `${key}.${ext}`) : null
}

function sessionMarkerPath(key: string): string | null {
  return sessionStatePath(key, 'marker')
}

/**
 * The keys an older hook-inject wrote this session's MARKER under — not the
 * checkpoint/counter forms, which `legacyHookSessionKeys` also returns for
 * their own readers (#1396 review).
 *
 * With a payload session_id, only forms derived from that id: #1228's `sid-`
 * key and the uncapped `safeSessionKey(payload)` main wrote before the 64-char
 * cap. Never the env/ppid forms: under payload-first keying a ppid marker can
 * never belong to this session (the ppid changes on every prompt), and stale
 * `<pid>.marker` files from releases before #1278 would otherwise make a new
 * session look already started and skip its injection.
 *
 * Without a payload session_id, main's own marker key: the uncapped
 * `safeSessionKey(env || ppid)`. Main never read the stripped checkpoint form
 * for markers, so neither does this.
 */
function legacyMarkerKeys(key: string, input: Record<string, unknown>): string[] {
  const id = input.session_id
  const payload = typeof id === 'string' && id ? id : ''
  const forms = payload
    ? [`sid-${safeSessionKey(payload)}`, safeSessionKey(payload)]
    : [safeSessionKey(process.env.CLAUDE_SESSION_ID || String(process.ppid || 'unknown'))]
  return [...new Set(forms.filter(k => k !== key))]
}

/**
 * The marker to READ for this session: the current key's, or — when it does
 * not exist — one an older writer left under a legacy key (H1 upgrade path:
 * #1228's `sid-` prefix or the uncapped form; see legacyMarkerKeys), so a session that
 * started before the upgrade is not injected twice. Writers use `key` only.
 *
 * #1395: null when the state dir is refused — read nothing, persist nothing.
 * The dir is resolved once and every legacy candidate is joined onto that
 * same verified dir, never onto an unverified one.
 */
function readableMarkerPath(key: string, input: Record<string, unknown>): string | null {
  const dir = sessionDir()
  if (!dir) return null
  const current = join(dir, `${key}.marker`)
  if (existsSync(current)) return current
  for (const legacy of legacyMarkerKeys(key, input)) {
    const p = join(dir, `${legacy}.marker`)
    if (existsSync(p)) return p
  }
  return current
}

function lastReminderPath(key: string): string | null {
  return sessionStatePath(key, 'reminded')
}

function readStdinSync(): Record<string, unknown> {
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(65536)
    while (true) {
      try {
        const n = readSync(0, buf, 0, buf.length, null)
        if (n === 0) break
        chunks.push(Buffer.from(buf.subarray(0, n)))
      } catch {
        break
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function isReminderDue(key: string): boolean {
  const path = lastReminderPath(key)
  if (!path) return false // no state dir: nothing marks the session, never reached
  try {
    const stat = statSync(path)
    return Date.now() - stat.mtimeMs > REMINDER_INTERVAL_MS
  } catch {
    // File doesn't exist = never reminded = due
    return true
  }
}

function touchReminder(key: string): void {
  // Fail-open: a state-dir write failing (unwritable $TMPDIR) must never crash
  // the prompt. The reminder timer is best-effort bookkeeping.
  const path = lastReminderPath(key)
  if (path) try { writeFileSync(path, String(Date.now()), { mode: 0o600 }) } catch { /* fail-open */ }
}

/**
 * What a hook holds after taking the inject lock: the file's inode and the
 * token written into it. `releaseInjectLock` deletes the lock only when the
 * file at `path` still has both — see there.
 */
export interface InjectLockHold { path: string; ino: number; token: string }

/**
 * Take the per-session inject lock (#519) with O_EXCL (formal r2, cli#7).
 *
 * The previous stat-then-write let two hooks that fired together both see
 * "no lock" and both write one — exactly the concurrent BGE loads the lock
 * exists to prevent. `wx` makes creation the test. A lock older than
 * LOCK_STALE_MS belongs to a crashed run and is taken over (one retry).
 *
 *   'acquired'    — ours; the caller MUST release it (in a finally) with
 *                   `releaseInjectLock(hold)`
 *   'busy'        — a live run holds it; bail
 *   'unavailable' — cannot lock at all (no trustworthy dir, I/O error);
 *                   proceed unlocked, the pre-#519 behaviour (fail open)
 */
export function takeInjectLock(
  path: string | null,
  opts: {
    staleMs?: number
    now?: () => number
    /** Test seam: runs between the staleness check and the takeover. */
    _beforeTakeover?: () => void
    /** Test seam: runs after the takeover moved the lock aside, before the put-back. */
    _afterMoveAside?: () => void
  } = {},
): { status: 'acquired' | 'busy' | 'unavailable'; hold?: InjectLockHold } {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS
  const now = opts.now ?? Date.now
  if (!path) return { status: 'unavailable' }
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return { status: 'unavailable' }
      try {
        const seen = statSync(path)
        if (now() - seen.mtimeMs < staleMs) return { status: 'busy' }
        opts._beforeTakeover?.()
        // Stale: the holder crashed — take it over. A plain unlink here let two
        // hooks that both saw it stale delete each other's fresh lock and both
        // inject (formal verification, R2-CLI item 3). Move whatever is at
        // `path` aside atomically, then check it is the stale file we judged
        // (inode AND mtime, so a filesystem that reuses inode numbers cannot
        // pass a fresh lock off as the stale one).
        const aside = `${path}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
        renameSync(path, aside)
        opts._afterMoveAside?.()
        const moved = statSync(aside)
        if (moved.ino === seen.ino && moved.mtimeMs === seen.mtimeMs) {
          unlinkSync(aside)
        } else {
          // A live lock arrived in between: put it back (link fails if yet
          // another holder already exists — either way someone holds it). If
          // the put-back fails, the moved lock's owner no longer holds `path`;
          // `releaseInjectLock` checks ownership, so it will not delete the
          // newer holder's lock (#1238).
          try { linkSync(aside, path) } catch { /* a newer holder exists */ }
          unlinkSync(aside)
          return { status: 'busy' }
        }
      } catch { /* vanished between open and stat — retry */ }
      continue
    }
    // Ours. Record what makes it ours: its inode and a token in its body.
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    let written = token
    try { writeSync(fd, token) } catch { written = '' /* the inode still identifies it */ }
    let ino = -1
    try { ino = fstatSync(fd).ino } catch { /* ino -1: release then leaves it to go stale */ }
    try { closeSync(fd) } catch { /* ignore */ }
    return { status: 'acquired', hold: { path, ino, token: written } }
  }
  return { status: 'busy' }
}

/** `takeInjectLock` without the hold — the status only. */
export function acquireInjectLock(
  path: string | null,
  staleMs: number = LOCK_STALE_MS,
  now: () => number = Date.now,
  /** Test seam: runs between the staleness check and the takeover. */
  _beforeTakeover?: () => void,
): 'acquired' | 'busy' | 'unavailable' {
  return takeInjectLock(path, { staleMs, now, _beforeTakeover }).status
}

/**
 * Release an inject lock this hook took — only if it is still this hook's
 * lock (#1238). A takeover that raced a third hook can leave `path` holding
 * ANOTHER hook's live lock; an unconditional unlink here deleted it, and a
 * fourth hook could then inject beside the third. The file is deleted only
 * when it has the inode and the token recorded at acquire time.
 */
export function releaseInjectLock(hold: InjectLockHold | undefined): void {
  if (!hold) return
  try {
    if (statSync(hold.path).ino !== hold.ino) return
    if (readFileSync(hold.path, 'utf8') !== hold.token) return
    unlinkSync(hold.path)
  } catch { /* already gone */ }
}

function extractEventTask(input: Record<string, unknown>, event: string): string {
  // Extract contextual task description based on event type
  const toolInput = input.tool_input as Record<string, unknown> | undefined

  switch (event) {
    case 'plan_mode':
      // Entering plan mode — inject broadly relevant engrams
      return (input.prompt as string) || 'implementation planning and architecture'

    case 'skill': {
      // Skill invocation — inject domain-specific engrams
      const skillName = String(toolInput?.skill ?? input.tool_name ?? '')
      return skillName ? `skill: ${skillName}` : 'skill invocation'
    }

    case 'agent': {
      // Agent spawn — inject agent-scoped engrams
      const agentType = String(toolInput?.subagent_type ?? toolInput?.description ?? '')
      const agentPrompt = String(toolInput?.prompt ?? '').slice(0, 200)
      return agentType ? `agent: ${agentType} ${agentPrompt}` : agentPrompt || 'agent task'
    }

    case 'subagent': {
      // Subagent start — similar to agent but for SubagentStart event
      // SubagentStart payloads carry `agent_type`, not tool_input.
      const desc = String(toolInput?.description ?? input.agent_type ?? input.agent_name ?? '')
      return desc ? `subagent: ${desc}` : 'subagent task'
    }

    default:
      return ''
  }
}

/** Is a process with this pid alive? EPERM means alive but not ours. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Deferred wrap-up (#216): recover sessions that ended without wrap-up.
 *
 * Scans <store>/sessions/ for checkpoint files left behind (plur_session_end
 * and hook-session-end both remove theirs). Formal r2, cli#6 — the property
 * is: A CHECKPOINT IS REMOVED ONLY AFTER A DURABLE CAPTURE
 * (PlurSpec/R2CLI.lean §2, `removed_only_after_capture`). Before:
 *   - a valid orphan produced a one-off notice in THIS session's context and
 *     was unlinked — nothing durable, so the previous session's only record
 *     was gone after a transient string (hook-session-end had been fixed for
 *     exactly this in #217; this path never was);
 *   - an unparseable checkpoint was unlinked outright;
 *   - "idle > 5 min" was the only orphan test, so a session still running in
 *     another terminal, between checkpoints (one every 10 responses), was
 *     declared dead and its checkpoint destroyed;
 *   - the scan read PLUR_PATH only, while the store and hook-session-end
 *     honour --path.
 * Now: an orphan is captured as an episode FIRST and unlinked only if that
 * succeeded; a corrupt checkpoint is renamed aside (kept, never rescanned);
 * a checkpoint whose key is a pid that is still alive is left alone (the
 * writer keys by ppid when CLAUDE_SESSION_ID is unset — the common case).
 *
 * Conservative: only reports metadata (stop count, duration, cwd).
 */
export function processDeferredWrapups(
  plur: Pick<Plur, 'capture'> & Partial<Pick<Plur, 'remoteOnlyFolder' | 'resolveFolderPolicy'>>,
  root: string,
  now: number = Date.now(),
  isAlive: (pid: number) => boolean = pidAlive,
): string | null {
  const sessionsDir = join(root, 'sessions')
  if (!existsSync(sessionsDir)) return null
  // A remote-only session captures no timeline (owner decision on #1521):
  // other sessions' orphans wait for a session that can capture them.
  if (plur.remoteOnlyFolder?.()) return null

  const notices: string[] = []
  try {
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.checkpoint.json'))
    // Skip checkpoints touched within the stale threshold — that session may
    // still be active in another terminal. Default 5 min; override via
    // PLUR_CHECKPOINT_STALE_MIN (minutes) for slower-cadence users.
    const staleMin = parseInt(process.env.PLUR_CHECKPOINT_STALE_MIN ?? '5', 10)
    const STALE_THRESHOLD_MS = Math.max(1, staleMin) * 60 * 1000

    for (const file of files) {
      const path = join(sessionsDir, file)
      const key = file.slice(0, -'.checkpoint.json'.length)
      let checkpoint: any
      let lastCheckpoint: number
      try {
        checkpoint = JSON.parse(readFileSync(path, 'utf8'))
        lastCheckpoint = new Date(checkpoint.last_checkpoint).getTime()
        if (!checkpoint || typeof checkpoint !== 'object' || Number.isNaN(lastCheckpoint)) throw new Error('corrupt')
      } catch {
        // Unparseable: keep the bytes (they are the session's only record),
        // move them out of the scan so they are not re-reported forever.
        try { renameSync(path, `${path}.corrupt`) } catch { /* leave it */ }
        continue
      }

      // Too recent — the session may still be active elsewhere.
      if (now - lastCheckpoint < STALE_THRESHOLD_MS) continue
      // A pid-keyed checkpoint whose process is alive is a LIVE session that
      // simply has not reached its next checkpoint. (PID reuse can only make
      // this skip a dead session — the safe direction; it is retried later.)
      if (/^\d+$/.test(key) && isAlive(Number(key))) continue

      // Calculate session duration
      const started = new Date(checkpoint.started_at)
      const durationMin = Math.max(0, Math.round((lastCheckpoint - started.getTime()) / 60000))
      const durationStr = Number.isNaN(durationMin) ? '?m' : durationMin >= 60
        ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
        : `${durationMin}m`
      const where = typeof checkpoint.cwd === 'string' && checkpoint.cwd
        ? ', ' + checkpoint.cwd.split('/').slice(-2).join('/') : ''
      const facts = `${durationStr}, ${checkpoint.stop_count ?? 0} responses${where}`

      // An orphan from a remote-only folder is dropped, not captured: its
      // timeline must not be kept on this machine (owner decision on #1521).
      if (typeof checkpoint.cwd === 'string' && checkpoint.cwd && plur.resolveFolderPolicy) {
        let policy: { mode: string; reason?: string } | null = null
        // When in doubt, don't capture (re-audit of #1521, C-1): an
        // unresolvable folder, or an unreadable map, leaves the checkpoint
        // uncaptured for a session that can decide.
        try { policy = plur.resolveFolderPolicy(checkpoint.cwd) } catch { continue }
        if (policy.reason === 'malformed-map') continue
        if (policy.mode === 'remote-only') {
          try { unlinkSync(path) } catch { /* gone */ }
          continue
        }
      }

      // Durable FIRST. Only a successful capture licenses the unlink.
      try {
        plur.capture(
          `Session ended without wrap-up (${facts}); recovered at the next session start.`,
          {
            channel: 'hook',
            agent: 'claude-code',
            session_id: typeof checkpoint.session_id === 'string' ? checkpoint.session_id : key,
            tags: ['session-end', 'deferred-wrapup'],
          },
        )
      } catch (err: unknown) {
        process.stderr.write(`[plur] deferred wrap-up: capture failed, keeping ${file}: ${(err as Error)?.message ?? err}\n`)
        continue
      }
      try { unlinkSync(path) } catch { /* captured; a leftover is re-captured at worst */ }
      notices.push(`Previous session (${facts}) ended without wrap-up.`)
    }
  } catch {
    return null
  }

  if (notices.length === 0) return null
  return `[PLUR] ${notices.join(' ')}\nConsider running plur_session_end with engram_suggestions when this session ends.`
}

// Self-watchdog ceiling for hook-inject. Hooks are fail-open — a silent
// exit after the ceiling is always better than an immortal orphan process
// (#504). The ceiling bounds OVERALL hook runtime: the floating background
// RemoteStore.load() that originally motivated it is gone (#776 — the remote
// leg is a budgeted, awaited call inside injectHybrid), but embedder loads,
// filesystem stalls, or any future stray async work still need a hard stop.
// #1313: the first-prompt and rehydrate injections are registered SYNC with
// a 20s Claude Code timeout (lib/claude-inject-budget.ts), so the default is
// 15s: it fits the 8s hybrid deadline plus a BM25 pass, and exits 0 before
// Claude Code kills the hook and shows an error. Override via env.
// The timer is unref()ed so a normal clean exit isn't delayed.
export const HOOK_CEILING_DEFAULT_MS = 15_000
// How long the watchdog, once fired, waits for this process's own store lock
// before exiting (#1343). Ceiling + this must still land before Claude Code's
// 20s kill, or the user sees a hook error instead of a quiet exit.
export const WATCHDOG_LOCK_WAIT_MS = 3_000
const HOOK_CEILING_MS = parseInt(process.env.PLUR_HOOK_CEILING_MS ?? '', 10) || HOOK_CEILING_DEFAULT_MS

/**
 * The first-prompt / rehydrate retrieval (#1313). The hook is sync, so it
 * cannot wait on an embedder for as long as it takes: hybrid races a soft
 * deadline (PLUR_HOOK_HYBRID_DEADLINE_MS, default 8s) and BM25 serves the
 * turn when it is missed or hybrid throws — the same bound the Codex and
 * Antigravity hooks use.
 */
export async function injectForHook<O, R>(
  plur: Injectable<O, R>,
  task: string,
  opts: O,
  deadlineMs?: number,
): Promise<InjectOutcome<R> & { hybrid: Promise<unknown> | null }> {
  // Keep hold of the hybrid search: when it misses the deadline it is still
  // running, and the exit must wait for it to finish its store write (#1313).
  let hybrid: Promise<unknown> | null = null
  const tracked: Injectable<O, R> = {
    inject: (t, o) => plur.inject(t, o),
    injectHybrid: (t, o) => {
      const p = plur.injectHybrid(t, o)
      hybridInFlight = true
      hybrid = p.catch(() => undefined).finally(() => { hybridInFlight = false })
      return p
    },
  }
  const outcome = await injectWithFallback(tracked, task, opts, deadlineMs)
  return { ...outcome, hybrid }
}

/**
 * Before force-exiting past a missed hybrid deadline, how long to wait for
 * the abandoned search to settle (#1313). When it is near the end it records
 * its injection under `engrams.yaml.lock`; exiting while that lock's O_EXCL
 * create is in flight leaves an empty lock core honours for 60s. When it is
 * still embedding a store with no cache it will not settle in time, and it is
 * not writing, so exiting at the bound is safe. Also capped by what is left
 * of the watchdog budget, so the hook still ends before Claude Code's 20s kill.
 */
export const ABANDONED_HYBRID_WAIT_MS = 5_000

/** Resolve true when `p` settles, or false after `ms`, whichever comes first. */
export function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<boolean>(r => { timer = setTimeout(() => r(false), Math.max(0, ms)) }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * Background build of the embedding cache (#1313 audit).
 *
 * Core saves `.embeddings-cache.json` only when a hybrid search runs to the
 * end. A first prompt whose search misses the deadline exits before that, so
 * on a store with a cold cache every session's first prompt missed the
 * deadline again and never got faster. After such a fallback the hook starts
 * `hook-inject --warm-embeddings`: detached, lowest CPU priority, one at a
 * time per store (the `.embeddings-warming` marker), bounded by
 * PLUR_WARM_CEILING_MS. It runs core's `similaritySearch`, which embeds every
 * active engram through the cache and saves it. That path takes no store
 * write lock at all; the cache file is written atomically.
 */
const WARM_MARKER = '.embeddings-warming'
// 60 min: the cache is saved only once the whole store is embedded, and at the
// lowest priority a 10,000-engram store did not finish inside 10 min on a busy
// machine. A dead holder is detected at once, so this bounds only a stuck build.
export const WARM_CEILING_MS = parseInt(process.env.PLUR_WARM_CEILING_MS ?? '', 10) || 60 * 60_000

/**
 * Is the marker at `path` held by a live build? False when there is no marker,
 * when its holder is a dead pid on this host, or when it is at least
 * WARM_CEILING_MS old. A marker on another host cannot be probed, so only its
 * age counts. The parent's pre-spawn check and the child's claim use this one
 * test, so a marker left by a killed build never blocks warming (#1414 review).
 */
export function warmMarkerHeld(path: string, now = Date.now()): boolean {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return false }
  const [host, pidRaw, tsRaw] = raw.trim().split(':')
  const age = now - Number(tsRaw)
  let alive = host !== hostname() // another host: cannot probe, trust the age
  if (host === hostname()) {
    try { process.kill(Number(pidRaw), 0); alive = true } catch (e: any) { alive = e?.code === 'EPERM' }
  }
  return alive && Number.isFinite(age) && age < WARM_CEILING_MS
}

/** Take the single-flight marker, or false when a live build holds it. */
export function claimWarmMarker(path: string, now = Date.now()): boolean {
  const token = `${hostname()}:${process.pid}:${now}`
  try { writeFileSync(path, token, { flag: 'wx' }); return true } catch (err: any) {
    if (err?.code !== 'EEXIST') return false
  }
  try {
    if (warmMarkerHeld(path, now)) return false
    unlinkSync(path)
    writeFileSync(path, token, { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

async function warmEmbeddingCache(flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const marker = join(plur.storageRoot, WARM_MARKER)
  if (!claimWarmMarker(marker)) return
  const release = () => {
    try { if (readFileSync(marker, 'utf8').includes(`:${process.pid}:`)) unlinkSync(marker) } catch { /* gone */ }
  }
  const ceiling = setTimeout(() => { release(); process.exit(0) }, WARM_CEILING_MS)
  ceiling.unref()
  // A signal's default action skips `finally`, which would leave the marker
  // behind (shutdown, logout, `pkill node`). Release it, then exit the way the
  // signal would have (128 + its number).
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
    process.once(sig, () => { release(); process.exit(code) })
  }
  // Lowest priority by default: the build must never compete with the editor.
  // PLUR_WARM_NICE (0–19) lets a user who wants it done sooner raise it.
  const nice = parseInt(process.env.PLUR_WARM_NICE ?? '', 10)
  try { setPriority(Number.isInteger(nice) && nice >= 0 && nice <= 19 ? nice : 19) } catch { /* not permitted — run at normal priority */ }
  try {
    await plur.similaritySearch('embedding cache warm-up', { limit: 1 })
  } catch { /* best-effort: the next fallback tries again */ } finally {
    release()
  }
}

function startEmbeddingWarmup(storageRoot: string, flags: GlobalFlags): void {
  // Cheap single-flight check here, with the same liveness and age test as the
  // child's claim, so a marker left by a dead build does not block the spawn.
  // The child still claims atomically.
  if (warmMarkerHeld(join(storageRoot, WARM_MARKER))) return
  const entry = process.argv[1]
  if (!entry) return
  const args = [entry, 'hook-inject', '--warm-embeddings', ...(flags.path ? ['--path', flags.path] : [])]
  try {
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env }).unref()
  } catch { /* fail-open: the next fallback tries again */ }
}

// How long before an inject lock is considered stale (defaults to HOOK_CEILING_MS).
// Separate from HOOK_CEILING_MS so tests can control lock staleness without
// also shrinking the watchdog timeout to the point where it fires during the test.
const LOCK_STALE_MS =
  process.env.PLUR_LOCK_STALE_MS !== undefined
    ? parseInt(process.env.PLUR_LOCK_STALE_MS, 10)
    : HOOK_CEILING_MS

// The inject lock this run holds, if any. The watchdog removes it before its
// process.exit(): exit skips every `finally`, and a lock left behind would make
// every prompt for the next LOCK_STALE_MS bail silently (#1278 review).
let heldInjectLock: InjectLockHold | null = null

// Full first-message injections allowed per session before the hook stops
// trying (#1278 review). Each attempt that does not finish — it threw, the
// watchdog stopped it, or the editor killed it at its hook timeout — leaves no
// marker, so without a cap a store that always overruns the timeout would run
// the full injection on every prompt of the session.
const MAX_INJECT_ATTEMPTS = 2

// Null when there is no usable state dir (#1395): nothing is counted, so the
// cap cannot apply, exactly as no marker can be written there either.
function attemptsPath(key: string): string | null {
  return sessionStatePath(key, 'attempts')
}

function readAttempts(key: string): number {
  const path = attemptsPath(key)
  if (!path) return 0
  try { return parseInt(readFileSync(path, 'utf8'), 10) || 0 } catch { return 0 }
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const isRehydrate = args.includes('--rehydrate')
  const eventIdx = args.indexOf('--event')
  const event = eventIdx >= 0 ? args[eventIdx + 1] : null
  // Background embedding-cache build started by an earlier fallback (#1313
  // audit). Not a hook invocation: no stdin, no output, its own ceiling. It
  // runs before the folder gate (#1347): the warmer is a detached child with
  // no payload, and the folder that spawned it was already on.
  if (args.includes('--warm-embeddings')) {
    await warmEmbeddingCache(flags)
    return
  }
  // Every path needs the payload (#1278): the session key comes from its
  // `session_id`, and the folder decision from its `cwd`. Reading stdin is a
  // single synchronous read.
  const input = readStdinSync()

  // The folder map (#1347) replaces the old isPlurConfigured() gate (#247):
  // off is silent; ask is silent except for the one question on the first
  // prompt of a session; on does the work below.
  const dir = payloadDir(input)
  const policy = hookFolderPolicy(dir, flags)
  if (policy.mode === 'off') return
  if (policy.mode === 'ask') {
    if (!isRehydrate && !event) await askFolder(input, dir, policy, flags)
    return
  }

  // Watchdog: guarantee this process exits even if something in the hook run
  // hangs (#504) — remote calls are individually budgeted since #776, so this
  // is the ceiling on the WHOLE run (embedder load, fs stalls, stray async).
  // Installed after the folder gate so it only fires for
  // sessions that actually do work. unref() prevents it from delaying clean exit.
  runStartedAt = Date.now()
  // #1343: the watchdog can fire mid-way through a store write, and exiting
  // there leaves the lock behind. Wait (bounded) until the store is idle first.
  const watchdog = setTimeout(() => {
    stopping = true
    // Through the ownership check (#1238): never a lock another run has taken over since.
    if (heldInjectLock) releaseInjectLock(heldInjectLock)
    // A hybrid search still running at the ceiling is embedding a cold store:
    // same as a missed deadline, the cache would stay cold (#1313 audit). The
    // check runs at the exit itself, after the store-idle wait (#1343).
    void exitWhenStoreIdle(WATCHDOG_LOCK_WAIT_MS, () => {
      if (hybridInFlight && storeRoot) startEmbeddingWarmup(storeRoot, runFlags)
      process.exit(0)
    })
  }, HOOK_CEILING_MS)
  watchdog.unref()

  const key = sessionKey(input)
  const marker = readableMarkerPath(key, input)

  // Contextual injection for specific events (plan_mode, skill, agent, subagent)
  if (event) {
    const task = extractEventTask(input, event)
    // Unknown event: nothing to inject. Print nothing — stdout is parsed as
    // hook output, and echoing the payload back was never valid output.
    if (!task) return

    const plur = createPlur(flags)
    bindHookFolder(plur, dir, policy)
    const label = `[PLUR Memory — ${event}]`

    // BM25-only, deliberately. Event hooks are SYNC — their whole point is
    // context arriving BEFORE the tool runs — and they're installed with a
    // 10s timeout. Hybrid search needs the BGE embedder, which costs ~20s
    // to load in a cold CLI process once the store is a few thousand
    // engrams: the hook got killed at the timeout on EVERY invocation,
    // burning CPU and injecting nothing. BM25 completes in a few seconds,
    // and event task strings ("skill: X", "agent: Y") are short keyword-ish
    // queries where BM25 holds its own against embeddings anyway. The main
    // first-message injection keeps hybrid, but it is sync too since #1313:
    // hybrid on an 8s soft deadline, then BM25, under a 20s hook timeout.
    // Attribute the retrieval to this session when the marker is readable, so
    // the memory receipt can count (engram, session) pairs from hook traffic —
    // which is the large majority of all injections.
    let eventSessionId: string | undefined
    if (marker) try { eventSessionId = JSON.parse(readFileSync(marker, 'utf8')).sessionId } catch { /* fail-open */ }
    const result = await plur.inject(task, { budget: 3000, source: 'hook', session_id: eventSessionId })
    recordInjected('claude', input.session_id, result.injected_ids) // #1310 auto-rate
    if (result.count > 0) {
      const parts: string[] = []
      if (result.directives) parts.push(result.directives)
      if (result.constraints) parts.push(result.constraints)
      if (result.consider) parts.push(result.consider)
      emitContext(
        claudeHookEventName(input, { rehydrate: false, event }),
        `${label} ${result.count} engrams\n\n${parts.join('\n')}`,
      )
    }
    return
  }

  // Session already started — check if periodic reminder is due
  if (!isRehydrate && marker && existsSync(marker)) {
    // Keep the latest prompt for rehydration after compaction (#1274 reads it).
    const prompt = input.prompt
    if (typeof prompt === 'string') writeSessionTask(input.session_id, prompt)
    const lines: string[] = []
    if (isReminderDue(key)) {
      touchReminder(key)
      const scope = policy.scope
      const scopeHint = scope ? ` Use scope "${scope}" for plur_learn calls in this project.` : ''
      lines.push(`[PLUR Memory Reminder] If the user corrected you, stated a preference, or you discovered a pattern — call plur_learn now.${scopeHint} Call plur_session_end with engram_suggestions before the conversation ends.`)
    }
    const correction = promptCorrection(input)
    if (correction) lines.push(correction)
    if (lines.length > 0) {
      emitContext(claudeHookEventName(input, { rehydrate: false, event: null }), lines.join('\n\n'))
    }
    return
  }

  // Per-session concurrency guard (#519): if another hook-inject is already
  // running the BGE-loading injection for this session, exit immediately.
  // Multiple rapid async firings (datacore#33) otherwise pile up at ~160 MB
  // RSS each and trigger an OOM cascade. Lock is stale after HOOK_CEILING_MS
  // so a crashed process never permanently blocks subsequent invocations.
  const lock = takeInjectLock(sessionStatePath(key, 'injecting'))
  if (lock.status === 'busy') return
  heldInjectLock = lock.hold ?? null

  // Release the lock on every exit, including a throw from the injection —
  // a lock left behind would make the retry on the next prompt bail silently
  // until it goes stale (#1278). Only a lock this hook still owns is removed
  // (#1238).
  try {
    if (!isRehydrate) {
      const attempts = readAttempts(key)
      if (attempts >= MAX_INJECT_ATTEMPTS) {
        await skipCappedSession(input, key, marker)
        return
      }
      // Counted BEFORE the heavy work: a run that is killed never gets to
      // record anything afterwards.
      const counter = attemptsPath(key)
      if (counter) try { writeFileSync(counter, String(attempts + 1)) } catch { /* fail-open */ }
    }
    await injectSession(input, key, marker, isRehydrate, flags, dir, policy)
  } finally {
    releaseInjectLock(lock.hold)
    heldInjectLock = null
  }
  // #1313: the output (if any) has been flushed — emitContextConfirmed waits
  // for it. Exit now rather than let the abandoned hybrid search keep a
  // synchronous hook, and the user's prompt, waiting. But not while this
  // process may be inside a store write: exiting there leaves the lock file
  // behind, and every writer (the next hook, the MCP server) then waits on it.
  // Checking for the lock file alone is not enough — the abandoned search's
  // O_EXCL create can be in flight at the check and land after it — so wait
  // for the search itself, bounded, then for any lock of ours still on disk.
  if (abandonedHybrid) {
    const left = () => Math.max(0, runStartedAt + HOOK_CEILING_MS - 1_000 - Date.now())
    const settled = await settleWithin(abandonedHybrid, Math.min(ABANDONED_HYBRID_WAIT_MS, left()))
    // Then the general guard (#1343): no lock operation of this process in
    // flight and no lock file of ours on disk, checked in the same step as
    // the exit. A search still running at that exit is still embedding the
    // store: the cache is cold and would stay cold, since it is saved only
    // when a search finishes. Build it in the background so the next
    // session's hybrid search meets the deadline (#1313 audit).
    await exitWhenStoreIdle(Math.min(EXIT_LOCK_WAIT_MS, left()), () => {
      if (!settled && hybridInFlight && storeRoot) startEmbeddingWarmup(storeRoot, flags)
      process.exit(0)
    })
  }
}

/**
 * #1347: the folder has no decision yet (or its `.plur.yaml` is untrusted).
 * On the first prompt of the session, print the one question and no memories;
 * every later prompt of the session prints nothing. Keyed on the payload
 * `session_id` (then CLAUDE_SESSION_ID), never ppid: a ppid key changes on
 * every prompt and would ask every time.
 */
async function askFolder(input: Record<string, unknown>, dir: string, policy: FolderPolicy, flags: GlobalFlags): Promise<void> {
  if (claudeHookEventName(input, { rehydrate: false, event: null }) !== 'UserPromptSubmit') return
  const id = (typeof input.session_id === 'string' && input.session_id) || process.env.CLAUDE_SESSION_ID || ''
  // No store discovery: asking must not register this folder's .plur store.
  const plur = createAskPlur(flags)
  const ask = folderAskOnce({
    dir, policy, sessionId: id, flags, plur,
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
  })
  if (ask) await emitContextConfirmed('UserPromptSubmit', ask)
}

// The hybrid search that missed its deadline and is still running (#1313).
let abandonedHybrid: Promise<unknown> | null = null
let storeRoot: string | null = null
let runFlags: GlobalFlags = {}
// True while a hybrid search started by injectForHook has not settled.
let hybridInFlight = false
let runStartedAt = Date.now()

// Moved to lib/store-lock-exit.ts (#1343) so every force-exiting hook shares it.
export { waitForOwnStoreLock }

/**
 * The cap is reached: mark the session so later prompts take the cheap
 * reminder path, and say once that automatic memory was skipped. Nothing here
 * touches the store — whatever made the full injection fail (a store too large
 * for the hook timeout, a store that does not load) would make a keyword-only
 * fallback fail the same way, so none is attempted.
 */
async function skipCappedSession(input: Record<string, unknown>, key: string, marker: string | null): Promise<void> {
  const task = (typeof input.prompt === 'string' && input.prompt) || 'general session'
  if (marker) try { writeFileSync(marker, JSON.stringify({ task, sessionId: randomUUID(), injection: 'skipped' })) } catch { /* fail-open */ }
  touchReminder(key)
  await emitContextConfirmed(
    claudeHookEventName(input, { rehydrate: false, event: null }),
    `[PLUR Memory — automatic injection skipped: the last ${MAX_INJECT_ATTEMPTS} attempts in this session did not finish] ` +
      'Call plur_session_start or plur_recall to load memory for this session.',
  )
}

async function injectSession(
  input: Record<string, unknown>,
  key: string,
  marker: string | null,
  isRehydrate: boolean,
  flags: GlobalFlags,
  dir: string,
  policy: FolderPolicy,
): Promise<void> {
  const hookEventName = claudeHookEventName(input, { rehydrate: isRehydrate, event: null })
  if (NO_CONTEXT_EVENTS.has(hookEventName)) return
  // Project remote routing is resolved with the Plur instance, below — see
  // lib/project-remote.ts. `scope`/`domain` are gated on directory trust too
  // (decision E3): they are not only a read filter — the header tells the
  // model to learn under the scope — so a cloned repo must not choose it.
  let projectRemote: ProjectRemote | null = null

  // Get task description from hook input
  let task: string
  // First message: the marker to write once the context is on stdout.
  let pendingMarker: string | null = null
  let newSessionId: string | undefined
  if (isRehydrate) {
    const summary = (input.compact_summary as string) || ''
    let original = readSessionTask(input.session_id)
    if (!original && marker) {
      try {
        const raw = readFileSync(marker, 'utf8')
        // Marker is JSON since 0.8.2 (was plain text before)
        try { original = JSON.parse(raw).task || raw } catch { original = raw }
      } catch {}
    }
    task = original ? `${original} ${summary}` : summary || 'general context rehydration'
  } else {
    task = (input.prompt as string) || ''
    // Even with empty prompt, start a session and inject broadly
    if (!task) {
      task = 'general session'
    }
    // Auto session start: generate a session ID. The marker that records it
    // is written only AFTER the context has reached stdout (#1278): with the
    // marker keyed on session_id, one failed, timed-out or killed injection
    // would otherwise leave the whole session without memory. Unmarked, the
    // next prompt simply tries again.
    newSessionId = randomUUID()
    pendingMarker = JSON.stringify({ task, sessionId: newSessionId })
    writeSessionTask(input.session_id, task)
    touchReminder(key) // Reset reminder timer on first message
    // Keyed by session id, so markers accumulate one per session: sweep
    // week-old state like every other hook family does (vetted dir only).
    const stateDir = sessionDir()
    if (stateDir) cleanupStaleSessionFiles(Date.now(), stateDir)
  }

  // Inject engrams (with project scope if configured). Read the session marker
  // now — not later where it's only used for the label — so the injection is
  // attributed to this session on the co_injection event the receipt reads.
  const plur = createPlur(flags)
  // remote-only folders: core reads only the team scope and packs (#remote-only).
  bindHookFolder(plur, dir, policy)
  // Known before the search starts, so the watchdog can start a cache build too.
  storeRoot = plur.storageRoot
  runFlags = flags

  // Resolves the config path once, reads it, and gates its remote fields on
  // directory trust (#1196). Fails closed; costs nothing when the project
  // declares no remote settings.
  projectRemote = resolveProjectRemote(plur, dir)
  // #1347: the session scope is the folder policy's (a map scope beats the
  // `.plur.yaml` hint); the domain is the `.plur.yaml`'s only when the policy
  // came from it. A scope is also what makes core dial its team store.
  const projectConfig = sessionSettings(policy, projectRemote.config)
  const remoteRefusedFrom = projectRemote.refusedFrom

  let injectSessionId: string | undefined = newSessionId
  if (!injectSessionId && marker) {
    try { injectSessionId = JSON.parse(readFileSync(marker, 'utf8')).sessionId } catch { /* fail-open */ }
  }
  // #776: the remote leg rides INSIDE injectHybrid — at most one remote call
  // per host per prompt. `.plur.yaml`'s remote_url/remote_token pass through
  // as remote_project (project config wins for the hook path; its presence
  // is the org context for dialing). Personal/non-project sessions without a
  // project scope or remote_project dial nothing — the strict
  // scope-relevance rule keeps prompts from a CWD without an implicated
  // remote store off the network entirely, with ONE exception: a store the
  // user marked `dial: always` in config.yaml is dialed from any CWD. That
  // is an explicit per-store opt-in to send (truncated) prompt text to that
  // host, not something a project can turn on.
  const injectOpts = {
    source: 'hook' as const,
    remote_timeout_ms: REMOTE_TIMEOUT_MS,
    ...(projectConfig.scope ? { scope: projectConfig.scope } : {}),
    ...(injectSessionId ? { session_id: injectSessionId } : {}),
    ...(projectRemote.remoteProject ? { remote_project: projectRemote.remoteProject } : {}),
  }
  let context: string | null = null
  let count = 0

  // #1313: bounded, because the hook is sync. On a missed deadline or a
  // hybrid failure, BM25 (local-only by design — inject() never dials)
  // serves the turn.
  const { result, mode, hybrid } = await injectForHook(plur, task, injectOpts)
  recordInjected('claude', input.session_id, result.injected_ids) // #1310 auto-rate
  // A missed deadline leaves the hybrid search running; it must not hold
  // the process (and so the prompt) open until the watchdog.
  abandonedHybrid = mode === 'bm25' && hybridEnabled() ? hybrid : null
  storeRoot = plur.storageRoot
  if (result.count > 0) {
    const parts: string[] = []
    if (result.directives) parts.push(result.directives)
    if (result.constraints) parts.push(result.constraints)
    if (result.consider) parts.push(result.consider)
    context = parts.join('\n')
    count = result.count
  }

  // A4′ (#776): per-host recall outcomes → JSONL log + rate-limited
  // degradation header lines (printed on state change, then ≤ once per 4h
  // per (host, state); skipped_cooldown/unsupported never print).
  const degradationLines = surfaceRemoteOutcomes(plur)

  // Build session header
  const parts: string[] = []

  // Session id for the label — already read above for injection attribution.
  const sessionId = injectSessionId

  if (isRehydrate) {
    parts.push(`[PLUR Memory — rehydrated after compaction, ${count} engrams]`)
  } else {
    parts.push(`[PLUR Memory — session started, ${count} engrams injected]`)
    if (sessionId) parts.push(`Session ID: ${sessionId}`)
    if (projectConfig.domain) parts.push(`Project domain: ${projectConfig.domain}`)
    if (projectConfig.scope) parts.push(`Project scope: ${projectConfig.scope} — use this scope for plur_learn calls`)

    // Deferred wrap-up: notify about orphaned previous sessions (#216)
    const deferredNotice = processDeferredWrapups(plur, checkpointRoot(flags))
    if (deferredNotice) parts.push('', deferredNotice)
  }

  // A4′ (#776): degradation header — one line per (host, state) change.
  for (const line of degradationLines) parts.push(line)
  // remote-only: where memory goes, and — once, at session start — that the
  // team server did not answer, so there is no memory this session.
  for (const line of remoteOnlyLines(plur, result, !isRehydrate)) parts.push(line)

  // #1196: say so. A remote leg that silently stops working is the regression
  // this gate could otherwise introduce — the user must be able to tell
  // "refused, here is the one command" from "quietly broken".
  if (remoteRefusedFrom) parts.push(projectRemoteRefusalNotice(remoteRefusedFrom, plur.storageRoot))
  // E3: an ignored scope/domain is said too, naming the file and `plur trust`.

  if (context) {
    parts.push('')
    parts.push(context)
  }

  // #1312: correction detection rides this output, after the memory.
  const correction = isRehydrate ? null : promptCorrection(input)
  if (correction) parts.push('', correction)

  if (parts.length === 0) return

  const delivered = await emitContextConfirmed(hookEventName, parts.join('\n'))
  // Fail-open: an unwritable state dir just means the next prompt re-injects.
  if (delivered && pendingMarker && marker) try { writeFileSync(marker, pendingMarker, { mode: 0o600 }) } catch { /* fail-open */ }
}
