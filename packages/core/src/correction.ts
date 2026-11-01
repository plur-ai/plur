/**
 * The correction and rule classifiers, listed together because each is tuned for a
 * different cost of error:
 * - `isCorrection` (learner.ts): real-time ingest in the agent plugins.
 * - `detectCorrectionPrompt`: the hook that nudges the agent to call plur_learn.
 *   High recall is fine because it only reminds; reports which patterns matched.
 * - dsh's `detectLearning` (packages/dsh/src/learn.ts): unattended capture,
 *   high precision; kept in dsh because dsh loads core lazily and must work
 *   without it installed.
 * Change one profile deliberately; do not merge them.
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

export interface DetectionResult {
  matched: boolean
  patterns: string[]
}

export function detectCorrectionPrompt(prompt: string): DetectionResult {
  const text = prompt.trim()
  if (!text) return { matched: false, patterns: [] }

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
