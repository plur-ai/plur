import { existsSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, readSync, statSync, readdirSync, unlinkSync, renameSync, openSync, closeSync, linkSync, writeSync, fstatSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir, homedir } from 'os'
import { randomUUID, randomBytes } from 'crypto'
import { createPlur, trustedProjectScope, storeTrustCheck, type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import { ensureSessionDir, cleanupStaleSessionFiles } from '../lib/codex-hook-io.js'
import { safeSessionKey } from '../lib/session-key.js'
import { checkpointRoot } from './hook-learn-check.js'

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
 * With --rehydrate: always injects (used by PostCompact hook after context
 * compaction to restore engrams that were lost).
 *
 * With --event <type>: contextual injection for specific tool events:
 *   --event plan_mode   Full engram injection when entering plan mode
 *   --event skill       Domain-specific engrams based on skill name
 *   --event agent       Agent-scoped engrams for spawned agent
 *   --event subagent    Inject agent-scoped engrams into subagent context
 *
 * Input: JSON on stdin (Claude Code hook format: {prompt, ...} or {compact_summary, ...})
 * Output: JSON on stdout with {additionalContext} or empty (exit 0)
 */

const REMINDER_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

// Project config (.plur.yaml) reading moved to @plur-ai/core/project-config
// so both this hook AND the MCP server's session_start handler can use it
// (the original duplication was the root cause of #177 — session_start
// ignored .plur.yaml because the reader lived in this CLI-only file).
import { claimHookDegradationLines, type Plur } from '@plur-ai/core'
import { resolveProjectRemote, projectRemoteRefusalNotice, type ProjectRemote } from '../lib/project-remote.js'

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

/**
 * The Claude Code hook family's state dir, VETTED (formal r2, cli#8) like the
 * Codex/Cursor/Antigravity dirs since #1060: a symlinked, foreign or
 * loose-mode dir returns null and every caller degrades to "no persistence"
 * — no marker (so each prompt injects), no reminder timer, no inject lock.
 * The old bare mkdirSync followed a planted symlink and trusted a marker
 * anyone could have written, which suppresses injection for the session.
 */
function sessionDir(): string | null {
  const dir = join(tmpdir(), 'plur-sessions')
  return ensureSessionDir(dir) ? dir : null
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
 */
export function injectSessionKey(input: Record<string, unknown>, ppid: number | string = process.ppid || 'unknown'): string {
  const sid = typeof input.session_id === 'string' ? input.session_id : ''
  return sid ? `sid-${safeSessionKey(sid)}` : String(ppid)
}

function statePath(dir: string | null, key: string, ext: string): string | null {
  return dir ? join(dir, `${key}.${ext}`) : null
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

function isReminderDue(path: string | null): boolean {
  if (!path) return false // no trustworthy timer — do not remind on every prompt
  try {
    const stat = statSync(path)
    return Date.now() - stat.mtimeMs > REMINDER_INTERVAL_MS
  } catch {
    // File doesn't exist = never reminded = due
    return true
  }
}

function touchReminder(path: string | null): void {
  // Fail-open: a state-dir write failing (unwritable $TMPDIR) must never crash
  // the prompt. The reminder timer is best-effort bookkeeping.
  if (!path) return
  try { writeFileSync(path, String(Date.now()), { mode: 0o600 }) } catch { /* fail-open */ }
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
      const desc = String(toolInput?.description ?? input.agent_name ?? '')
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
  plur: Pick<Plur, 'capture'>,
  root: string,
  now: number = Date.now(),
  isAlive: (pid: number) => boolean = pidAlive,
): string | null {
  const sessionsDir = join(root, 'sessions')
  if (!existsSync(sessionsDir)) return null

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
// Defaults to 55 s (within the 90 s harness timeout); override via env.
// The timer is unref()ed so a normal clean exit isn't delayed.
const HOOK_CEILING_MS = parseInt(process.env.PLUR_HOOK_CEILING_MS ?? '', 10) || 55_000

// How long before an inject lock is considered stale (defaults to HOOK_CEILING_MS).
// Separate from HOOK_CEILING_MS so tests can control lock staleness without
// also shrinking the watchdog timeout to the point where it fires during the test.
const LOCK_STALE_MS =
  process.env.PLUR_LOCK_STALE_MS !== undefined
    ? parseInt(process.env.PLUR_LOCK_STALE_MS, 10)
    : HOOK_CEILING_MS

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  // Silent pass-through for projects without plur configured (#247).
  // Lets hooks be installed globally without affecting non-plur projects.
  if (!isPlurConfigured()) return

  // Watchdog: guarantee this process exits even if something in the hook run
  // hangs (#504) — remote calls are individually budgeted since #776, so this
  // is the ceiling on the WHOLE run (embedder load, fs stalls, stray async).
  // Installed after isPlurConfigured() so it only fires for
  // sessions that actually do work. unref() prevents it from delaying clean exit.
  const watchdog = setTimeout(() => process.exit(0), HOOK_CEILING_MS)
  watchdog.unref()

  const isRehydrate = args.includes('--rehydrate')
  const eventIdx = args.indexOf('--event')
  const event = eventIdx >= 0 ? args[eventIdx + 1] : null
  // Read the payload first: it carries the session identity (cli#7).
  const input = readStdinSync()
  const stateDir = sessionDir()
  const key = injectSessionKey(input)
  const marker = statePath(stateDir, key, 'marker')
  const reminderPath = statePath(stateDir, key, 'reminded')

  // Contextual injection for specific events (plan_mode, skill, agent, subagent)
  if (event) {
    const task = extractEventTask(input, event)
    if (!task) {
      // Passthrough — nothing to inject for
      process.stdout.write(JSON.stringify(input))
      return
    }

    const plur = createPlur(flags)
    const label = `[PLUR Memory — ${event}]`

    // BM25-only, deliberately. Event hooks are SYNC — their whole point is
    // context arriving BEFORE the tool runs — and they're installed with a
    // 10s timeout. Hybrid search needs the BGE embedder, which costs ~20s
    // to load in a cold CLI process once the store is a few thousand
    // engrams: the hook got killed at the timeout on EVERY invocation,
    // burning CPU and injecting nothing. BM25 completes in a few seconds,
    // and event task strings ("skill: X", "agent: Y") are short keyword-ish
    // queries where BM25 holds its own against embeddings anyway. The main
    // first-message injection keeps full hybrid — it runs async with room
    // to breathe.
    // Attribute the retrieval to this session when the marker is readable, so
    // the memory receipt can count (engram, session) pairs from hook traffic —
    // which is the large majority of all injections.
    let eventSessionId: string | undefined
    try { if (marker) eventSessionId = JSON.parse(readFileSync(marker, 'utf8')).sessionId } catch { /* fail-open */ }
    const result = await plur.inject(task, { budget: 3000, source: 'hook', session_id: eventSessionId })
    if (result.count > 0) {
      const parts: string[] = []
      if (result.directives) parts.push(result.directives)
      if (result.constraints) parts.push(result.constraints)
      if (result.consider) parts.push(result.consider)
      const output = { additionalContext: `${label} ${result.count} engrams\n\n${parts.join('\n')}` }
      process.stdout.write(JSON.stringify(output))
    }
    return
  }

  // Session already started — check if periodic reminder is due
  if (!isRehydrate && marker && existsSync(marker)) {
    if (isReminderDue(reminderPath)) {
      touchReminder(reminderPath)
      // Same trust gate as session start (decision E3): an untrusted
      // .plur.yaml does not get to name the scope the model writes under.
      const reminderRemote = resolveProjectRemote(storeTrustCheck(flags))
      const projectConfig = trustedProjectScope(storeTrustCheck(flags), reminderRemote.config, reminderRemote.configDir)
      const scopeHint = projectConfig.scope ? ` Use scope "${projectConfig.scope}" for plur_learn calls in this project.` : ''
      const output = {
        additionalContext: `[PLUR Memory Reminder] If the user corrected you, stated a preference, or you discovered a pattern — call plur_learn now.${scopeHint} Call plur_session_end with engram_suggestions before the conversation ends.`,
      }
      process.stdout.write(JSON.stringify(output))
    }
    return
  }

  // Per-session concurrency guard (#519): if another hook-inject is already
  // running the BGE-loading injection for this session, exit immediately.
  // Multiple rapid async firings (datacore#33) otherwise pile up at ~160 MB
  // RSS each and trigger an OOM cascade. Lock is stale after HOOK_CEILING_MS
  // so a crashed process never permanently blocks subsequent invocations.
  const lock = takeInjectLock(statePath(stateDir, key, 'injecting'))
  if (lock.status === 'busy') return
  // Released on EVERY exit from here on, including a throw (cli#7): the
  // BM25 fallback, createPlur and the project-config reads can all throw,
  // and a lock left behind silenced injection for LOCK_STALE_MS (55 s).
  try {
    await injectAndReport(isRehydrate, input, marker, reminderPath, stateDir, flags)
  } finally {
    releaseInjectLock(lock.hold)
  }
}

async function injectAndReport(
  isRehydrate: boolean,
  input: Record<string, unknown>,
  marker: string | null,
  reminderPath: string | null,
  stateDir: string | null,
  flags: GlobalFlags,
): Promise<void> {
  // Project remote routing is resolved with the Plur instance, below — see
  // lib/project-remote.ts. `scope`/`domain` are gated on directory trust too
  // (decision E3): they are not only a read filter — the header tells the
  // model to learn under the scope — so a cloned repo must not choose it.
  let projectRemote: ProjectRemote | null = null

  // Get task description from hook input
  let task: string
  if (isRehydrate) {
    const summary = (input.compact_summary as string) || ''
    let original = ''
    try {
      if (!marker) throw new Error('no marker')
      const raw = readFileSync(marker, 'utf8')
      // Marker is JSON since 0.8.2 (was plain text before)
      try { original = JSON.parse(raw).task || raw } catch { original = raw }
    } catch {}
    task = original ? `${original} ${summary}` : summary || 'general context rehydration'
  } else {
    task = (input.prompt as string) || ''
    // Even with empty prompt, start a session and inject broadly
    if (!task) {
      task = 'general session'
    }
    // Auto session start: generate session ID and save with task.
    // Fail-open: if the state dir is unwritable, skip the marker (the session
    // header is read back defensively below) rather than crash the prompt.
    const sessionId = randomUUID()
    if (marker) try { writeFileSync(marker, JSON.stringify({ task, sessionId }), { mode: 0o600 }) } catch { /* fail-open */ }
    touchReminder(reminderPath) // Reset reminder timer on first message
    // Keyed by session id now, so markers accumulate one per session: sweep
    // week-old state like every other hook family does (vetted dir only).
    if (stateDir) cleanupStaleSessionFiles(Date.now(), stateDir)
  }

  // Inject engrams (with project scope if configured). Read the session marker
  // now — not later where it's only used for the label — so the injection is
  // attributed to this session on the co_injection event the receipt reads.
  const plur = createPlur(flags)

  // Resolves the config path once, reads it, and gates its remote fields on
  // directory trust (#1196). Fails closed; costs nothing when the project
  // declares no remote settings.
  projectRemote = resolveProjectRemote(plur)
  const projectConfig = trustedProjectScope(plur, projectRemote.config, projectRemote.configDir)
  const remoteRefusedFrom = projectRemote.refusedFrom

  let injectSessionId: string | undefined
  try { if (marker) injectSessionId = JSON.parse(readFileSync(marker, 'utf8')).sessionId } catch { /* fail-open */ }
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

  try {
    const result = await plur.injectHybrid(task, injectOpts)
    if (result.count > 0) {
      const parts: string[] = []
      if (result.directives) parts.push(result.directives)
      if (result.constraints) parts.push(result.constraints)
      if (result.consider) parts.push(result.consider)
      context = parts.join('\n')
      count = result.count
    }
  } catch {
    // Fall back to BM25 (local-only by design — inject() never dials).
    const result = await plur.inject(task, injectOpts)
    if (result.count > 0) {
      const parts: string[] = []
      if (result.directives) parts.push(result.directives)
      if (result.constraints) parts.push(result.constraints)
      if (result.consider) parts.push(result.consider)
      context = parts.join('\n')
      count = result.count
    }
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

  // #1196: say so. A remote leg that silently stops working is the regression
  // this gate could otherwise introduce — the user must be able to tell
  // "refused, here is the one command" from "quietly broken".
  if (remoteRefusedFrom) parts.push(projectRemoteRefusalNotice(remoteRefusedFrom, plur.storageRoot))
  // E3: an ignored scope/domain is said too, naming the file and `plur trust`.
  if (projectConfig.notice && !isRehydrate) parts.push(projectConfig.notice)

  if (context) {
    parts.push('')
    parts.push(context)
  }

  if (parts.length === 0) return

  const output = { additionalContext: parts.join('\n') }
  process.stdout.write(JSON.stringify(output))
}
