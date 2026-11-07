import { mkdirSync, appendFileSync, readSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { detectSecrets } from '@plur-ai/core'
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

// security audit 2026-11-06: observations kept tokens and .env contents verbatim.
/** `text` with every word detectSecrets flags redacted; a secret no single word carries withholds the whole value. */
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
  const dateStr = new Date().toISOString().slice(0, 10)
  const obsFile = join(obsDir, `${dateStr}.jsonl`)

  try {
    mkdirSync(obsDir, { recursive: true, mode: 0o700 })
    appendFileSync(obsFile, JSON.stringify(obs) + '\n', { mode: 0o600 })
  } catch {
    // Never block on write failure
  }
}
