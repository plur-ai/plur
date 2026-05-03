import { readSync } from 'fs'
import { type GlobalFlags } from '../plur.js'

/**
 * plur hook-revert-detect — PostToolUse hook for revert-style operations.
 *
 * Detects when the agent (or user) just executed a "revert my recent action"
 * command — git checkout, git reset --hard, git restore, git revert, rm of
 * recently-edited files, etc. Emits a system reminder asking the agent to
 * reflect on what went wrong and consider whether the lesson belongs in
 * plur_learn.
 *
 * Reverts are a strong behavioral signal of a mistake. They're more reliable
 * than waiting for the user to articulate a correction.
 *
 * Input: JSON on stdin (Claude Code PostToolUse hook format)
 * Output: JSON {hookSpecificOutput: {additionalContext}} when matched, else empty.
 */

// Bash command patterns that indicate a revert-style operation
const REVERT_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\bgit\s+checkout\s+(--\s+)?[\w./-]+/i, description: 'git checkout' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, description: 'git reset --hard' },
  { pattern: /\bgit\s+restore\b/i, description: 'git restore' },
  { pattern: /\bgit\s+revert\b/i, description: 'git revert' },
  { pattern: /\bgit\s+stash\s+(drop|clear)\b/i, description: 'git stash drop' },
]

// Patterns that look like reverts but aren't (initial setup, not a mistake recovery)
const FALSE_POSITIVE_PATTERNS: RegExp[] = [
  /\bgit\s+checkout\s+-b\b/i,           // creating a new branch
  /\bgit\s+checkout\s+(main|master|develop)\b/i,  // switching branches, not reverting files
]

interface DetectionResult {
  matched: boolean
  command: string | null
  description: string | null
}

export function detectRevert(toolName: string, command: string): DetectionResult {
  if (toolName !== 'Bash') return { matched: false, command: null, description: null }
  const text = command.trim()
  if (!text) return { matched: false, command: null, description: null }

  if (FALSE_POSITIVE_PATTERNS.some(p => p.test(text))) {
    return { matched: false, command: null, description: null }
  }

  for (const { pattern, description } of REVERT_PATTERNS) {
    if (pattern.test(text)) {
      return { matched: true, command: text, description }
    }
  }
  return { matched: false, command: null, description: null }
}

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

export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  const raw = readStdinRaw()
  if (!raw.trim()) return

  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }

  const toolName = String(data.tool_name ?? data.name ?? '')
  const toolInput = (data.tool_input ?? {}) as Record<string, unknown>
  const command = String(toolInput.command ?? '')
  if (!toolName || !command) return

  const result = detectRevert(toolName, command)
  if (!result.matched) return

  const reminder =
    'REVERT DETECTED: just ran "' + (result.description ?? 'revert command') + '" — ' +
    '"' + (result.command ?? '').slice(0, 120) + '"\n\n' +
    'A revert is a strong signal that something went wrong. Before continuing:\n' +
    '1. Briefly identify what failed and why (in your next response or reasoning).\n' +
    '2. If the cause is a generalizable rule (you took a wrong approach, missed a ' +
    'precondition, made an assumption), call plur_learn to capture it.\n' +
    '3. Then continue the task with the lesson applied.\n\n' +
    'Skip if the revert was an intended workflow step (resetting an experimental ' +
    'branch, undoing a planned try-and-revert), not a mistake recovery.'

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: reminder,
    },
  }
  process.stdout.write(JSON.stringify(output))
}
