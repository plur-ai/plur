import { readSync } from 'fs'
import { type GlobalFlags } from '../plur.js'
import { detectCorrectionPrompt as detectCorrection } from '@plur-ai/core'

/**
 * plur hook-correction-detect — UserPromptSubmit hook. On a strong
 * correction-shaped phrase, emits a reminder to consider plur_learn, since
 * agents often acknowledge corrections without storing them. Advisory only:
 * never blocks or calls plur_learn itself.
 * Input: JSON on stdin (Claude Code UserPromptSubmit hook format)
 * Output: JSON {hookSpecificOutput: {additionalContext}} when matched, else empty.
 */

export { detectCorrection }
/**
 * The reminder text for a correction-shaped prompt, or null. Shared by this
 * standalone hook and by `hook-inject`, which appends it to its
 * UserPromptSubmit output so no second per-prompt process is needed.
 */
export function correctionReminder(prompt: string): string | null {
  const result = detectCorrection(prompt)
  if (!result.matched) return null
  return (
    'CORRECTION SIGNAL DETECTED in user message. Phrase(s) matched: ' +
    result.patterns.map(p => `"${p}"`).join(', ') + '\n\n' +
    'BEFORE you continue this task, consider whether the user just stated a ' +
    'durable rule, preference, or correction. If yes, call plur_learn NOW ' +
    'with the rule + rationale, then proceed. Acknowledging in prose is not ' +
    'enough — that lesson disappears with context-window compression.\n\n' +
    'Skip if the matched phrase is not actually corrective in this context ' +
    '(e.g. "actually" used as filler, "from now on" used in a non-rule sense).'
  )
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

  const reminder = correctionReminder(String(data.prompt ?? data.user_message ?? ''))
  if (!reminder) return

  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: reminder,
    },
  }
  process.stdout.write(JSON.stringify(output))
}
