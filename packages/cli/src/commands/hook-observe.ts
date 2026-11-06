import { mkdirSync, appendFileSync, readSync, existsSync, readdirSync, unlinkSync, statSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { detectSecrets, protectOwnerOnly } from '@plur-ai/core'
import { type GlobalFlags } from '../plur.js'
import { hookFolderPolicy, payloadDir, parsePayload } from '../lib/folder-gate.js'

/**
 * plur hook-observe — capture tool calls for offline pattern extraction.
 *
 * Called by PreToolUse and PostToolUse hooks. Logs observations to
 * ~/.plur/observations/YYYY-MM-DD.jsonl for later analysis.
 *
 * This creates raw material for engram generation without relying on
 * the LLM calling plur_learn. Hook capture is 100% deterministic.
 *
 * Input: JSON on stdin (Claude Code hook format)
 * Output: passthrough (writes stdin to stdout unchanged)
 *
 * Usage:
 *   npx @plur-ai/cli hook-observe              # PreToolUse (default)
 *   npx @plur-ai/cli hook-observe --post        # PostToolUse
 *   npx @plur-ai/cli hook-observe --failure      # PostToolUseFailure
 */

// Tools that generate too much noise and little learning value
const SKIP_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'TaskCreate', 'TaskUpdate',
  'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  'ToolSearch',
])

function readStdinRaw(): string {
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
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return ''
  }
}

/** What is scanned past the kept length, so a token the trim would cut is still whole when scanned. */
const SCAN_MARGIN = 1024
/** Runs of characters scanned on their own: shell words, quoted values, `KEY=value` pairs. */
const WORD = /[^\s"'`,;]+/g

/**
 * `text` with every word detectSecrets flags replaced by `[REDACTED:secret]`
 * (security audit 2026-11-06: observations kept `export GH_TOKEN=…`, bearer
 * headers and `.env` contents verbatim, a data class learn() and ingest()
 * refuse to store). A secret no single word carries (a `Bearer <token>`
 * pair, a PEM block, a percent-encoded form) withholds the whole value.
 */
function redactText(text: string): string {
  if (detectSecrets(text).length === 0) return text
  const out = text.replace(WORD, w => detectSecrets(w).length > 0 ? '[REDACTED:secret]' : w)
  return detectSecrets(out).length > 0 ? '[REDACTED:secret]' : out
}

/** A tool-input value as observed: secrets redacted BEFORE the trim, then trimmed. */
function observeValue(v: unknown, maxLen = 200): unknown {
  if (typeof v === 'string') {
    const redacted = redactText(v.slice(0, maxLen + SCAN_MARGIN))
    return redacted.length > maxLen || v.length > maxLen + SCAN_MARGIN ? redacted.slice(0, maxLen) + '...[trimmed]' : redacted
  }
  if (v !== null && typeof v === 'object') {
    // A structured value (a list of edits, say) is kept whole only when clean.
    try {
      const text = JSON.stringify(v)
      if (typeof text === 'string' && detectSecrets(text).length > 0) return '[REDACTED:secret]'
    } catch { return '[REDACTED:unserializable]' }
  }
  return v
}

/** How long an observation file is kept (security audit 2026-11-06: nothing pruned them). */
const RETENTION_DAYS = 30
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/** Delete day files older than {@link RETENTION_DAYS}. Best effort. */
function pruneObservations(obsDir: string, now: Date): void {
  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  let names: string[]
  try { names = readdirSync(obsDir) } catch { return }
  for (const name of names) {
    const m = DAY_FILE.exec(name)
    if (!m) continue
    const day = Date.parse(`${m[1]}T00:00:00Z`)
    if (Number.isFinite(day) && day < cutoff) {
      try { unlinkSync(join(obsDir, name)) } catch { /* best effort */ }
    }
  }
}

/**
 * Owner-only for the observations folder (0700) and its files (0600). New
 * ones are born that way through the mkdir/append modes; on Unix an older,
 * wider one is narrowed here (a stat per write). Windows gets the owner-only
 * access list when the folder or file is created (icacls is too slow to run
 * on every tool call).
 */
function keepOwnerOnly(path: string, created: boolean, directory: boolean): void {
  if (process.platform === 'win32') {
    if (created) protectOwnerOnly(path, { directory })
    return
  }
  try {
    const want = directory ? 0o700 : 0o600
    if ((statSync(path).mode & 0o777) !== want) chmodSync(path, want)
  } catch { /* never block the tool call */ }
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const raw = readStdinRaw()

  // Always passthrough stdin to stdout (hook contract)
  process.stdout.write(raw)

  // No capture unless the folder map says on (#1347; was #247's project gate).
  // Not in a remote-only folder either: an observation keeps tool input
  // (commands, edits) in this machine's store, which such a folder forbids
  // (gate review of #1663).
  if (hookFolderPolicy(payloadDir(parsePayload(raw)), flags).mode !== 'on') return

  let data: Record<string, unknown>
  try {
    data = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return
  }

  const toolName = String(data.tool_name ?? data.name ?? '')
  if (!toolName || SKIP_TOOLS.has(toolName)) return

  // Determine event type
  const isPost = args.includes('--post')
  const isFailure = args.includes('--failure')
  const event = isFailure ? 'PostToolUseFailure' : isPost ? 'PostToolUse' : 'PreToolUse'

  // Build observation
  const obs: Record<string, unknown> = {
    ts: new Date().toISOString(),
    event,
    tool: toolName,
    session: process.env.CLAUDE_SESSION_ID ?? 'unknown',
    cwd: process.cwd(),
  }

  // Capture tool input (trimmed) for PreToolUse
  if (event === 'PreToolUse') {
    const toolInput = data.tool_input as Record<string, unknown> | undefined
    if (toolInput && typeof toolInput === 'object') {
      const trimmed: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(toolInput)) {
        trimmed[k] = observeValue(v)
      }
      obs.input = trimmed
    }
  }

  // Capture success/failure for PostToolUse
  if (event === 'PostToolUse') {
    obs.success = true
  }
  if (event === 'PostToolUseFailure') {
    obs.success = false
    const error = data.error ?? data.message ?? ''
    if (error) obs.error = redactText(String(error).slice(0, 500 + SCAN_MARGIN)).slice(0, 500)
  }

  // Write to observations JSONL
  const obsDir = join(
    process.env.PLUR_PATH ?? join(homedir(), '.plur'),
    'observations'
  )
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  const obsFile = join(obsDir, `${dateStr}.jsonl`)

  try {
    const dirExisted = existsSync(obsDir)
    mkdirSync(obsDir, { recursive: true, mode: 0o700 })
    keepOwnerOnly(obsDir, !dirExisted, true)
    const fileExisted = existsSync(obsFile)
    appendFileSync(obsFile, JSON.stringify(obs) + '\n', { mode: 0o600 })
    keepOwnerOnly(obsFile, !fileExisted, false)
    // Once per day file, not on every tool call.
    if (!fileExisted) pruneObservations(obsDir, now)
  } catch {
    // Never block on write failure
  }
}
