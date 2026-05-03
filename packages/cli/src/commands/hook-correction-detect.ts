import { readSync } from 'fs'
import { type GlobalFlags } from '../plur.js'

/**
 * plur hook-correction-detect — UserPromptSubmit hook.
 *
 * Scans the user's prompt for correction-shaped phrases. When a strong
 * pattern matches, emits a system reminder asking the agent to consider
 * calling plur_learn to capture the durable rule before continuing.
 *
 * This closes a known capture gap: agents acknowledge corrections in prose
 * but don't store them as engrams, so the same correction must be repeated
 * in the next session.
 *
 * The hook is purely advisory — it doesn't block, doesn't call plur_learn
 * itself. The agent decides whether the rule is engram material.
 *
 * Input: JSON on stdin (Claude Code UserPromptSubmit hook format)
 * Output: JSON {hookSpecificOutput: {additionalContext}} when matched, else empty.
 */

// Strong patterns — high confidence the user is correcting / setting a rule.
// Anchored to start-of-message or with explicit lead-ins to reduce false
// positives. Tuned conservatively: prefer missing some signals over crying
// wolf on every "no problem" / "actually that's fine" message.
const STRONG_PATTERNS: RegExp[] = [
  /^(no, )/i,                          // "no, that's wrong"
  /^(actually,? )/i,                   // "actually..."
  /^(wait,? )/i,                       // "wait, what I meant"
  /^(let me clarify)/i,
  /\b(from now on|going forward)\b/i,
  /\b(the right way (is|to)|the correct way (is|to))\b/i,
  /\b(I want|we want) (?:\w+\s+){0,4}not \w+/i,
  /\b(don'?t|never) (do|use|call|run|edit|modify) /i,
  /\b(always|must) (do|use|call|run|edit|verify|check) /i,
  /\bwhat I meant (was|is)\b/i,
  /\byou (misunderstood|got that wrong|missed)\b/i,
  /\bthat'?s not what I (meant|asked|said|wanted)\b/i,
  /\b(remember|note) (this|that)\b/i,
  /\b(the way we do|how we do) [a-z]+\b/i,
  /\bI prefer\b/i,
  /\bfor [a-z]+ tasks?,? you (should|must|need to) /i,
]

// Phrases that look like corrections but usually aren't — explicit allow-list
// to silence noise.
const FALSE_POSITIVE_PATTERNS: RegExp[] = [
  /^(no problem|no worries|no thanks|no thank you)/i,
  /^(actually that'?s fine|actually that works)/i,
  /^(wait a (sec|moment|second))/i,
]

interface DetectionResult {
  matched: boolean
  patterns: string[]
}

export function detectCorrection(prompt: string): DetectionResult {
  const text = prompt.trim()
  if (!text) return { matched: false, patterns: [] }

  // Skip false-positives
  if (FALSE_POSITIVE_PATTERNS.some(p => p.test(text))) {
    return { matched: false, patterns: [] }
  }

  const matched: string[] = []
  for (const p of STRONG_PATTERNS) {
    const m = text.match(p)
    if (m) matched.push(m[0])
  }

  return { matched: matched.length > 0, patterns: matched }
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

  const prompt = String(data.prompt ?? data.user_message ?? '')
  if (!prompt) return

  const result = detectCorrection(prompt)
  if (!result.matched) return

  const reminder =
    'CORRECTION SIGNAL DETECTED in user message. Phrase(s) matched: ' +
    result.patterns.map(p => `"${p}"`).join(', ') + '\n\n' +
    'BEFORE you continue this task, consider whether the user just stated a ' +
    'durable rule, preference, or correction. If yes, call plur_learn NOW ' +
    'with the rule + rationale, then proceed. Acknowledging in prose is not ' +
    'enough — that lesson disappears with context-window compression.\n\n' +
    'Skip if the matched phrase is not actually corrective in this context ' +
    '(e.g. "actually" used as filler, "from now on" used in a non-rule sense).'

  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: reminder,
    },
  }
  process.stdout.write(JSON.stringify(output))
}
