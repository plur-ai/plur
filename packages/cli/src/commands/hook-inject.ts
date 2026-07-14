import { existsSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, readSync, statSync, readdirSync, unlinkSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir, homedir } from 'os'
import { randomUUID } from 'crypto'
import { createPlur, type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'

// Hard cap on the prompt text sent to Enterprise. Engram retrieval only
// needs enough signal to rank candidates; the rest is privacy bleed
// (Taleb #5, critic #4). 1KB is generous for relevance and trivial for
// the network.
const MAX_REMOTE_TASK_CHARS = 1000

// Hard cap on remote response body. Prevents OOM/stall from a misconfigured
// or adversarial server returning multi-megabyte JSON (critic #9).
const MAX_REMOTE_RESPONSE_BYTES = 128 * 1024  // 128 KB

// AbortController timeout — keep low. The hook is on the hot path of
// every prompt; slow networks make this a perceptible latency tax
// (Taleb #4). 1500ms is the trade-off: long enough for healthy remote
// round trips, short enough to be invisible when the network is fine.
const REMOTE_TIMEOUT_MS = 1500

// Failure-log dir. tryRemoteInject is fail-open by design (it MUST
// never block the user's prompt) — but silent fail-open is unfalsifiable
// (Taleb #2): you cannot distinguish "Enterprise is working but had no
// engrams for this query" from "Enterprise is unreachable and we
// silently degraded to local." Each remote attempt writes ONE JSON LINE.
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
  outcome:   'ok' | 'http_error' | 'timeout' | 'network_error' | 'bad_response' | 'oversize'
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
import { findProjectConfigPath, readProjectConfig, type ProjectConfig } from '@plur-ai/core'

/**
 * POST to ${remote_url}/api/v1/inject — fire a fast HTTP injection.
 *
 * Returns the formatted context text on success, or null on any failure.
 * NEVER throws: hooks must degrade open or they break the user's prompt.
 *
 * Privacy:
 *   - Only the first MAX_REMOTE_TASK_CHARS of the task are sent (truncated
 *     locally before transmission). Engram ranking doesn't need the full
 *     prompt; truncation reduces inadvertent exfiltration of pasted
 *     secrets, credentials, or proprietary content (critic #4, taleb #5).
 *   - URL is normalized via the URL constructor — strips path/query/
 *     fragment cleanly so /api/v1/inject doesn't double up if the user
 *     wrote `remote_url: https://x.com/api` (data #EC07).
 *
 * Robustness:
 *   - AbortController stays live through the full request lifecycle
 *     (headers + body). Cleared in finally so the timer doesn't fire
 *     against a settled request (critic #1, cto #4, data #EC01, dijkstra #7).
 *   - Response body is capped at MAX_REMOTE_RESPONSE_BYTES via
 *     content-length check; oversize responses → null (critic #9).
 *   - data.text trimmed before truthy check; whitespace-only payloads
 *     are treated as empty (data #EC08).
 */
async function tryRemoteInject(
  config: ProjectConfig,
  task:   string,
): Promise<{ text: string; count: number; injectedIds: string[] } | null> {
  if (!config.remote_url || !config.remote_token) return null
  const startTs = Date.now()

  // Normalize the URL to the origin so /api/v1/inject can't double up
  // on a misconfigured remote_url with a path component.
  let base: string
  try {
    base = new URL(config.remote_url).origin
  } catch {
    logRemoteAttempt({ ts: new Date().toISOString(), url: config.remote_url ?? '?', outcome: 'bad_response', ms: 0, detail: 'invalid URL' })
    return null  // bogus URL → silent local fallback
  }
  const url  = `${base}/api/v1/inject`

  // Truncate task before it leaves the machine.
  const truncatedTask = task.length > MAX_REMOTE_TASK_CHARS
    ? task.slice(0, MAX_REMOTE_TASK_CHARS)
    : task

  const body: Record<string, unknown> = { task: truncatedTask }
  if (config.remote_scopes && config.remote_scopes.length > 0) {
    body.scopes = config.remote_scopes
  }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), REMOTE_TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'authorization': `Bearer ${config.remote_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      logRemoteAttempt({ ts: new Date().toISOString(), url, outcome: 'http_error', ms: Date.now() - startTs, http: r.status })
      return null
    }

    // Guard against oversized response. content-length is advisory but
    // most servers set it correctly; for missing/chunked responses the
    // AbortController still terminates the body read at timeout.
    const contentLength = r.headers.get('content-length')
    if (contentLength && parseInt(contentLength, 10) > MAX_REMOTE_RESPONSE_BYTES) {
      logRemoteAttempt({ ts: new Date().toISOString(), url, outcome: 'oversize', ms: Date.now() - startTs, http: r.status, detail: `content-length=${contentLength}` })
      return null
    }

    // r.json() reads the body — AbortController still live so a slow
    // body trickle gets cut off at REMOTE_TIMEOUT_MS overall budget.
    const data = await r.json() as { text?: string; count?: number; injected_ids?: string[] }
    if (typeof data.text !== 'string' || !data.text.trim()) {
      logRemoteAttempt({ ts: new Date().toISOString(), url, outcome: 'bad_response', ms: Date.now() - startTs, http: r.status, detail: 'empty or non-string text field' })
      return null
    }
    const count = typeof data.count === 'number' ? data.count : 0
    logRemoteAttempt({ ts: new Date().toISOString(), url, outcome: 'ok', ms: Date.now() - startTs, http: r.status, engrams: count })
    return {
      text:        data.text,
      count,
      injectedIds: Array.isArray(data.injected_ids) ? data.injected_ids : [],
    }
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === 'AbortError'
    logRemoteAttempt({
      ts: new Date().toISOString(),
      url,
      outcome: isAbort ? 'timeout' : 'network_error',
      ms: Date.now() - startTs,
      detail: err instanceof Error ? err.message.slice(0, 120) : undefined,
    })
    return null
  } finally {
    clearTimeout(t)
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

function sessionMarkerPath(): string {
  const ppid = process.ppid || 'unknown'
  return join(sessionDir(), `${ppid}.marker`)
}

function lastReminderPath(): string {
  const ppid = process.ppid || 'unknown'
  return join(sessionDir(), `${ppid}.reminded`)
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

function isReminderDue(): boolean {
  const path = lastReminderPath()
  try {
    const stat = statSync(path)
    return Date.now() - stat.mtimeMs > REMINDER_INTERVAL_MS
  } catch {
    // File doesn't exist = never reminded = due
    return true
  }
}

function touchReminder(): void {
  // Fail-open: a state-dir write failing (unwritable $TMPDIR) must never crash
  // the prompt. The reminder timer is best-effort bookkeeping.
  try { writeFileSync(lastReminderPath(), String(Date.now())) } catch { /* fail-open */ }
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
// when a background RemoteStore.load() hangs on a degraded network (#504).
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

  // Watchdog: guarantee this process exits even if a background network call
  // hangs (#504). Installed after isPlurConfigured() so it only fires for
  // sessions that actually do work. unref() prevents it from delaying clean exit.
  const watchdog = setTimeout(() => process.exit(0), HOOK_CEILING_MS)
  watchdog.unref()

  const isRehydrate = args.includes('--rehydrate')
  const eventIdx = args.indexOf('--event')
  const event = eventIdx >= 0 ? args[eventIdx + 1] : null
  const marker = sessionMarkerPath()

  // Contextual injection for specific events (plan_mode, skill, agent, subagent)
  if (event) {
    const input = readStdinSync()
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
    const result = plur.inject(task, { budget: 3000 })
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
  if (!isRehydrate && existsSync(marker)) {
    if (isReminderDue()) {
      touchReminder()
      const projectConfig = readProjectConfig()
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
  const injectLock = join(sessionDir(), `${process.ppid || 'unknown'}.injecting`)
  let injectLockAcquired = false
  try {
    const s = statSync(injectLock)
    if (Date.now() - s.mtimeMs < LOCK_STALE_MS) return
  } catch { /* no lock file — proceed */ }
  try { writeFileSync(injectLock, ''); injectLockAcquired = true } catch { /* fail-open */ }

  const input = readStdinSync()
  const projectConfig = readProjectConfig()

  // Get task description from hook input
  let task: string
  if (isRehydrate) {
    const summary = (input.compact_summary as string) || ''
    let original = ''
    try {
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
    try { writeFileSync(marker, JSON.stringify({ task, sessionId })) } catch { /* fail-open */ }
    touchReminder() // Reset reminder timer on first message
  }

  // Inject engrams (with project scope if configured)
  const plur = createPlur(flags)
  const injectOpts = projectConfig.scope ? { scope: projectConfig.scope } : undefined
  let context: string | null = null
  let count = 0
  let remoteUsed = false

  // Remote-first when the project has opted in (.plur.yaml has remote_url +
  // remote_token). Personal/non-project sessions skip this entirely —
  // findProjectConfigPath returns null and the config is empty, so the
  // network call is never made. Privacy guarantee: prompts from a CWD
  // without a .plur.yaml never reach Enterprise.
  if (projectConfig.remote_url && projectConfig.remote_token) {
    const remote = await tryRemoteInject(projectConfig, task)
    if (remote && remote.count > 0) {
      context = remote.text
      count = remote.count
      remoteUsed = true
    }
    // If remote returned null or zero engrams, fall through to local so
    // the user still gets personal-store context.
  }

  if (!remoteUsed) {
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
      // Fall back to BM25
      const result = plur.inject(task, injectOpts)
      if (result.count > 0) {
        const parts: string[] = []
        if (result.directives) parts.push(result.directives)
        if (result.constraints) parts.push(result.constraints)
        if (result.consider) parts.push(result.consider)
        context = parts.join('\n')
        count = result.count
      }
    }
  }

  // Build session header
  const parts: string[] = []

  // Read back session info for the label
  let sessionId: string | undefined
  try {
    const markerData = JSON.parse(readFileSync(marker, 'utf8'))
    sessionId = markerData.sessionId
  } catch {}

  const sourceLabel = remoteUsed ? ' (Enterprise)' : ''
  if (isRehydrate) {
    parts.push(`[PLUR Memory${sourceLabel} — rehydrated after compaction, ${count} engrams]`)
  } else {
    parts.push(`[PLUR Memory${sourceLabel} — session started, ${count} engrams injected]`)
    if (sessionId) parts.push(`Session ID: ${sessionId}`)
    if (projectConfig.domain) parts.push(`Project domain: ${projectConfig.domain}`)
    if (projectConfig.scope) parts.push(`Project scope: ${projectConfig.scope} — use this scope for plur_learn calls`)

    // Deferred wrap-up: notify about orphaned previous sessions (#216)
    const deferredNotice = processDeferredWrapups()
    if (deferredNotice) parts.push('', deferredNotice)
  }

  if (context) {
    parts.push('')
    parts.push(context)
  }

  if (injectLockAcquired) try { unlinkSync(injectLock) } catch {}
  if (parts.length === 0) return

  const output = { additionalContext: parts.join('\n') }
  process.stdout.write(JSON.stringify(output))
}
