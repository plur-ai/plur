import { existsSync, writeFileSync, readFileSync, mkdirSync, readSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createPlur, type GlobalFlags } from '../plur.js'

/**
 * plur hook-inject — Claude Code hook for engram injection.
 *
 * Called by UserPromptSubmit hook. First call injects engrams based on the
 * user's prompt. Subsequent calls check if a reminder is due (every 10 min).
 *
 * With --rehydrate: always injects (used by PostCompact hook after context
 * compaction to restore engrams that were lost).
 *
 * Input: JSON on stdin (Claude Code hook format: {prompt, ...} or {compact_summary, ...})
 * Output: JSON on stdout with {additionalContext} or empty (exit 0)
 */

const REMINDER_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

function sessionDir(): string {
  const dir = join(tmpdir(), 'plur-sessions')
  mkdirSync(dir, { recursive: true })
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
  writeFileSync(lastReminderPath(), String(Date.now()))
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const isRehydrate = args.includes('--rehydrate')
  const marker = sessionMarkerPath()

  // Session already started — check if periodic reminder is due
  if (!isRehydrate && existsSync(marker)) {
    if (isReminderDue()) {
      touchReminder()
      const output = {
        additionalContext: '[PLUR Memory Reminder] If the user corrected you, stated a preference, or you discovered a pattern — call plur_learn now. Call plur_session_end with engram_suggestions before the conversation ends.',
      }
      process.stdout.write(JSON.stringify(output))
    }
    return
  }

  const input = readStdinSync()

  // Get task description from hook input
  let task: string
  if (isRehydrate) {
    const summary = (input.compact_summary as string) || ''
    let original = ''
    try { original = readFileSync(marker, 'utf8') } catch {}
    task = original ? `${original} ${summary}` : summary || 'general context rehydration'
  } else {
    task = (input.prompt as string) || ''
    if (!task) {
      writeFileSync(marker, '')
      return
    }
    writeFileSync(marker, task)
    touchReminder() // Reset reminder timer on first message
  }

  // Inject engrams
  const plur = createPlur(flags)
  let context: string | null = null
  let count = 0

  try {
    const result = await plur.injectHybrid(task)
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
    const result = plur.inject(task)
    if (result.count > 0) {
      const parts: string[] = []
      if (result.directives) parts.push(result.directives)
      if (result.constraints) parts.push(result.constraints)
      if (result.consider) parts.push(result.consider)
      context = parts.join('\n')
      count = result.count
    }
  }

  if (!context) {
    return
  }

  const label = isRehydrate
    ? `[PLUR Memory — rehydrated after compaction, ${count} engrams]`
    : `[PLUR Memory — ${count} engrams injected]`

  const output = { additionalContext: `${label}\n\n${context}` }
  process.stdout.write(JSON.stringify(output))
}
