import { existsSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, readSync, statSync, readdirSync, unlinkSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir, homedir, hostname } from 'os'
import { randomUUID } from 'crypto'
import { createPlur, type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import { recordInjected } from '../lib/auto-rate.js'
import { safeSessionKey } from '../lib/session-key.js'
import { injectWithFallback, hybridEnabled, type Injectable, type InjectOutcome } from '../lib/codex-hook-io.js'

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

/**
 * The last task seen for a Claude Code session, keyed on the payload
 * `session_id`. The SessionStart(compact) payload carries no compact_summary,
 * so rehydration queries with this. It is rewritten on every prompt; the
 * session marker keeps only the first one.
 */
function sessionTaskPath(input: Record<string, unknown>): string | null {
  const id = input.session_id
  return typeof id === 'string' && id ? join(sessionDir(), `${safeSessionKey(id)}.task`) : null
}

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
  const id = input.session_id
  const raw =
    (typeof id === 'string' && id) ||
    process.env.CLAUDE_SESSION_ID ||
    String(process.ppid || 'unknown')
  return safeSessionKey(raw)
}

function emitContext(hookEventName: string, additionalContext: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }))
}

/**
 * emitContext that resolves true once the write has been handed to stdout
 * without error (on macOS a pipe write is asynchronous), false otherwise.
 * The session marker is written only after this resolves true (#1278).
 */
function emitContextConfirmed(hookEventName: string, additionalContext: string): Promise<boolean> {
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
import { readProjectConfig, claimHookDegradationLines, type Plur } from '@plur-ai/core'
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

function sessionDir(): string {
  const dir = join(tmpdir(), 'plur-sessions')
  // Fail-open: an unwritable $TMPDIR (read-only tmpfs, full disk) must never
  // crash the prompt. Swallow the mkdir error and return the path anyway —
  // downstream state-dir writes are individually wrapped and degrade to no-ops.
  try { mkdirSync(dir, { recursive: true }) } catch { /* fail-open */ }
  return dir
}

function sessionMarkerPath(key: string): string {
  return join(sessionDir(), `${key}.marker`)
}

function lastReminderPath(key: string): string {
  return join(sessionDir(), `${key}.reminded`)
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
  try { writeFileSync(lastReminderPath(key), String(Date.now())) } catch { /* fail-open */ }
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

/**
 * Deferred wrap-up (#216): detect orphaned sessions from previous runs.
 *
 * Scans ~/.plur/sessions/ for checkpoint files without a matching
 * session_end episode. If found, generates a brief recovery notice
 * and cleans up the checkpoint. Returns a notice string or null.
 *
 * Conservative: only reports metadata (stop count, duration, cwd).
 * Does not attempt LLM-quality summaries — that context is gone.
 */
function processDeferredWrapups(): string | null {
  const plurDir = process.env.PLUR_PATH ?? join(homedir(), '.plur')
  const sessionsDir = join(plurDir, 'sessions')
  if (!existsSync(sessionsDir)) return null

  const notices: string[] = []
  try {
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.checkpoint.json'))
    const now = Date.now()
    // Skip checkpoints touched within the stale threshold — that session may
    // still be active in another terminal. Default 5 min; override via
    // PLUR_CHECKPOINT_STALE_MIN (minutes) for slower-cadence users.
    const staleMin = parseInt(process.env.PLUR_CHECKPOINT_STALE_MIN ?? '5', 10)
    const STALE_THRESHOLD_MS = Math.max(1, staleMin) * 60 * 1000

    for (const file of files) {
      const path = join(sessionsDir, file)
      try {
        const checkpoint = JSON.parse(readFileSync(path, 'utf8'))
        const lastCheckpoint = new Date(checkpoint.last_checkpoint).getTime()

        // Skip if checkpoint is too recent (session may still be active elsewhere)
        if (now - lastCheckpoint < STALE_THRESHOLD_MS) continue

        // Calculate session duration
        const started = new Date(checkpoint.started_at)
        const ended = new Date(checkpoint.last_checkpoint)
        const durationMin = Math.round((ended.getTime() - started.getTime()) / 60000)
        const durationStr = durationMin >= 60
          ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
          : `${durationMin}m`

        notices.push(
          `Previous session (${durationStr}, ${checkpoint.stop_count} responses` +
          `${checkpoint.cwd ? ', ' + checkpoint.cwd.split('/').slice(-2).join('/') : ''}) ` +
          `ended without wrap-up.`,
        )

        // Clean up the checkpoint
        unlinkSync(path)
      } catch {
        // Corrupt checkpoint — remove it
        try { unlinkSync(path) } catch {}
      }
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
const HOOK_CEILING_MS = parseInt(process.env.PLUR_HOOK_CEILING_MS ?? '', 10) || HOOK_CEILING_DEFAULT_MS

/**
 * The first-prompt / rehydrate retrieval (#1313). The hook is sync, so it
 * cannot wait on an embedder for as long as it takes: hybrid races a soft
 * deadline (PLUR_HOOK_HYBRID_DEADLINE_MS, default 8s) and BM25 serves the
 * turn when it is missed or hybrid throws — the same bound the Codex and
 * Antigravity hooks use.
 */
export function injectForHook<O, R>(
  plur: Injectable<O, R>,
  task: string,
  opts: O,
  deadlineMs?: number,
): Promise<InjectOutcome<R>> {
  return injectWithFallback(plur, task, opts, deadlineMs)
}

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
  // Every path needs the payload now (#1278): the session key comes from its
  // `session_id`. Reading stdin is a single synchronous read.
  const input = readStdinSync()
  const key = sessionKey(input)
  const marker = sessionMarkerPath(key)

  // Contextual injection for specific events (plan_mode, skill, agent, subagent)
  if (event) {
    const task = extractEventTask(input, event)
    // Unknown event: nothing to inject. Print nothing — stdout is parsed as
    // hook output, and echoing the payload back was never valid output.
    if (!task) return

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
    try { eventSessionId = JSON.parse(readFileSync(marker, 'utf8')).sessionId } catch { /* fail-open */ }
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
  if (!isRehydrate && existsSync(marker)) {
    // Keep the latest prompt for rehydration after compaction (#1274 reads it).
    const prompt = input.prompt
    const taskPath = sessionTaskPath(input)
    if (taskPath && typeof prompt === 'string' && prompt) {
      try { writeFileSync(taskPath, prompt) } catch { /* fail-open */ }
    }
    if (isReminderDue(key)) {
      touchReminder(key)
      const projectConfig = readProjectConfig()
      const scopeHint = projectConfig.scope ? ` Use scope "${projectConfig.scope}" for plur_learn calls in this project.` : ''
      emitContext(
        claudeHookEventName(input, { rehydrate: false, event: null }),
        `[PLUR Memory Reminder] If the user corrected you, stated a preference, or you discovered a pattern — call plur_learn now.${scopeHint} Call plur_session_end with engram_suggestions before the conversation ends.`,
      )
    }
    return
  }

  // Per-session concurrency guard (#519): if another hook-inject is already
  // running the BGE-loading injection for this session, exit immediately.
  // Multiple rapid async firings (datacore#33) otherwise pile up at ~160 MB
  // RSS each and trigger an OOM cascade. Lock is stale after HOOK_CEILING_MS
  // so a crashed process never permanently blocks subsequent invocations.
  const injectLock = join(sessionDir(), `${key}.injecting`)
  let injectLockAcquired = false
  try {
    const s = statSync(injectLock)
    if (Date.now() - s.mtimeMs < LOCK_STALE_MS) return
  } catch { /* no lock file — proceed */ }
  try { writeFileSync(injectLock, ''); injectLockAcquired = true } catch { /* fail-open */ }

  // Release the lock on every exit, including a throw from the injection —
  // a lock left behind would make the retry on the next prompt bail silently
  // until it goes stale (#1278).
  try {
    await injectSession(input, key, marker, isRehydrate, flags)
  } finally {
    if (injectLockAcquired) try { unlinkSync(injectLock) } catch {}
  }
  // #1313: the output (if any) has been flushed — emitContextConfirmed waits
  // for it. Exit now rather than let the abandoned hybrid search keep a
  // synchronous hook, and the user's prompt, waiting. But not while this
  // process may be inside a store write: exiting there leaves the lock file
  // behind, and every writer (the next hook, the MCP server) then waits on it.
  if (abandonedHybrid) {
    if (storeLockPath) await waitForOwnStoreLock(storeLockPath, 5_000)
    process.exit(0)
  }
}

// Set when the hybrid leg missed its deadline and is still running (#1313).
let abandonedHybrid = false
let storeLockPath: string | null = null

/**
 * Wait (bounded) while this process may hold the store's cross-process lock.
 *
 * The abandoned hybrid search still records its injection, under
 * `engrams.yaml.lock`. Measured on a 10,000-engram store: force-exiting right
 * after the BM25 answer left an EMPTY lock file — the O_EXCL open had
 * happened, the token write had not — and core cannot tell who owns an empty
 * lock, so it waits out its 60s stale threshold. Every following first prompt
 * hit the 15s watchdog and injected nothing.
 *
 * Ours = the token names this host and pid. Empty and fresh = possibly ours,
 * mid-acquire. An empty lock older than 2s belongs to someone else.
 */
export async function waitForOwnStoreLock(lockPath: string, maxMs: number): Promise<void> {
  const until = Date.now() + maxMs
  const ours = `${hostname()}:${process.pid}:`
  while (Date.now() < until) {
    let mayBeOurs = false
    try {
      const token = readFileSync(lockPath, 'utf8').trim()
      mayBeOurs = token === ''
        ? Date.now() - statSync(lockPath).mtimeMs < 2_000
        : token.startsWith(ours)
    } catch { /* no lock file — nothing to wait for */ }
    if (!mayBeOurs) return
    await new Promise(r => setTimeout(r, 25))
  }
}

async function injectSession(
  input: Record<string, unknown>,
  key: string,
  marker: string,
  isRehydrate: boolean,
  flags: GlobalFlags,
): Promise<void> {
  const hookEventName = claudeHookEventName(input, { rehydrate: isRehydrate, event: null })
  if (NO_CONTEXT_EVENTS.has(hookEventName)) return
  // Project remote routing is resolved with the Plur instance, below — see
  // lib/project-remote.ts. `scope`/`domain` are read here because they are
  // local filters and need no gate.
  let projectRemote: ProjectRemote | null = null

  // Get task description from hook input
  let task: string
  // First message: the marker to write once the context is on stdout.
  let pendingMarker: string | null = null
  let newSessionId: string | undefined
  if (isRehydrate) {
    const summary = (input.compact_summary as string) || ''
    let original = ''
    const taskPath = sessionTaskPath(input)
    try { if (taskPath) original = readFileSync(taskPath, 'utf8') } catch {}
    if (!original) {
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
    const taskPath = sessionTaskPath(input)
    if (taskPath) try { writeFileSync(taskPath, task) } catch { /* fail-open */ }
    touchReminder(key) // Reset reminder timer on first message
  }

  // Inject engrams (with project scope if configured). Read the session marker
  // now — not later where it's only used for the label — so the injection is
  // attributed to this session on the co_injection event the receipt reads.
  const plur = createPlur(flags)

  // Resolves the config path once, reads it, and gates its remote fields on
  // directory trust (#1196). Fails closed; costs nothing when the project
  // declares no remote settings.
  projectRemote = resolveProjectRemote(plur)
  const projectConfig = projectRemote.config
  const remoteRefusedFrom = projectRemote.refusedFrom

  let injectSessionId: string | undefined = newSessionId
  if (!injectSessionId) {
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
  const { result, mode } = await injectForHook(plur, task, injectOpts)
  recordInjected('claude', input.session_id, result.injected_ids) // #1310 auto-rate
  // A missed deadline leaves the hybrid search running; it must not hold
  // the process (and so the prompt) open until the watchdog.
  abandonedHybrid = mode === 'bm25' && hybridEnabled()
  storeLockPath = join(plur.storageRoot, 'engrams.yaml.lock')
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
    const deferredNotice = processDeferredWrapups()
    if (deferredNotice) parts.push('', deferredNotice)
  }

  // A4′ (#776): degradation header — one line per (host, state) change.
  for (const line of degradationLines) parts.push(line)

  // #1196: say so. A remote leg that silently stops working is the regression
  // this gate could otherwise introduce — the user must be able to tell
  // "refused, here is the one command" from "quietly broken".
  if (remoteRefusedFrom) parts.push(projectRemoteRefusalNotice(remoteRefusedFrom))

  if (context) {
    parts.push('')
    parts.push(context)
  }

  if (parts.length === 0) return

  const delivered = await emitContextConfirmed(hookEventName, parts.join('\n'))
  // Fail-open: an unwritable state dir just means the next prompt re-injects.
  if (delivered && pendingMarker) try { writeFileSync(marker, pendingMarker) } catch { /* fail-open */ }
}
