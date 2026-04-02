import { mkdirSync, appendFileSync, readSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { type GlobalFlags } from '../plur.js'

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

function trimValue(v: unknown, maxLen = 200): unknown {
  if (typeof v === 'string' && v.length > maxLen) {
    return v.slice(0, maxLen) + '...[trimmed]'
  }
  return v
}

export async function run(args: string[], _flags: GlobalFlags): Promise<void> {
  const raw = readStdinRaw()

  // Always passthrough stdin to stdout (hook contract)
  process.stdout.write(raw)

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
        trimmed[k] = trimValue(v)
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
    if (error) obs.error = String(error).slice(0, 500)
  }

  // Write to observations JSONL
  const obsDir = join(
    process.env.PLUR_PATH ?? join(homedir(), '.plur'),
    'observations'
  )
  const dateStr = new Date().toISOString().slice(0, 10)
  const obsFile = join(obsDir, `${dateStr}.jsonl`)

  try {
    mkdirSync(obsDir, { recursive: true })
    appendFileSync(obsFile, JSON.stringify(obs) + '\n')
  } catch {
    // Never block on write failure
  }
}
