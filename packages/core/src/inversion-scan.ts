/**
 * Heuristic, READ-ONLY detector for engrams the negation-inversion bug class
 * in `learner.ts` (`CORRECTION_PATTERNS` / `PREFERENCE_PATTERNS`, fixed
 * 2026-09, E1 of the opencode-plugin audit follow-up) may have already
 * written into a store before the fix landed.
 *
 * The shipped extractor produced these for as long as it existed, so a real
 * user's store — including a remote/team store synced from a machine that
 * never got the fix — can carry confident standing instructions that mean
 * the OPPOSITE of what was actually said ("never commit the API key" stored
 * as "commit the API key", or "is not allowed" stored as "is"). Neither
 * `plur tensions` (contradiction detection between TWO engrams) nor the
 * secret/sensitivity scanners (unrelated content classes) look for this
 * shape at all.
 *
 * This module only REPORTS suspects. It never rewrites an engram: a
 * truncated fragment cannot be reliably reconstructed into its original
 * meaning — which word was dropped ("never"? "don't"? was there ever a
 * negation?), and guessing wrong would corrupt the memory a second time,
 * silently. A human reviews each suspect and decides: fix the statement by
 * hand, retire it, or confirm it was a false positive (plenty of clean
 * statements legitimately end in a preposition or start with a bare verb).
 *
 * HEURISTIC, NOT PROOF. Every check here pattern-matches the SURVIVING
 * text — the very thing the bug already mangled — so it will both miss real
 * inversions (a short one-word tail can read as a complete thought, e.g.
 * "use pnpm, not npm" truncated to "use pnpm") and flag some statements
 * that are simply written in an unusual shape. Every finding is a
 * suggestion to look, never a verdict. See `docs/` note in the CLI's
 * `plur audit --source engrams` help text, which repeats this caveat where
 * a user actually sees it.
 */

export interface InversionSuspect {
  id: string
  statement: string
  /**
   * Which recognizable shape(s) this statement matches. A statement can
   * match both — that is a STRONGER signal, not a double-count of the same
   * one.
   *
   * - `truncated-tail`: the statement ends on a word that cannot end a
   *   complete standing instruction (a copula, modal, preposition,
   *   conjunction, article, or a dangling "not") — the exact shape
   *   `CORRECTION_PATTERNS[1]`'s pre-fix `/(.+?),?\s+not\s+(.+)/i` left
   *   behind when it captured only the text before "not".
   * - `bare-imperative`: the statement opens with a common action verb and
   *   no leading subject, hedge, or polarity word (no "never", "don't",
   *   "you should", …) — consistent with either half of the two other
   *   pre-fix bugs: `PREFERENCE_PATTERNS`' old `(?:always|never)\s+(.+)` /
   *   `(?:you should|you must|don't|do not)\s+(.+)` (captured only the
   *   tail, dropping the directive word), or the SURVIVING half of an
   *   "X, not Y" contrast whose second half was dropped ("use pnpm" from
   *   "use pnpm, not npm").
   */
  shapes: Array<'truncated-tail' | 'bare-imperative'>
  reason: string
}

// The exact tail shape `/(.+?),?\s+not\s+(.+)/i` (matched[1] only) produces
// from "X is/was/should/must/does/… not Y", plus the connective/article
// shape left over when a sentence was cut at a comma rather than at "not".
// Deliberately closed and small: only words that cannot legitimately end a
// COMPLETE standing instruction. Common false-positive-prone words (nouns,
// most verbs) are never in here.
const TAIL_FUNCTION_WORDS = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did',
  'should', 'would', 'could', 'must', 'might', 'may', 'will', 'shall', 'can',
  'has', 'have', 'had',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as',
  'a', 'an', 'the',
  'and', 'or', 'but', 'so', 'that', 'because',
  // a dangling negation is exactly as incomplete as what usually follows it
  'not',
])

// Narrow, explicitly a guess (see module docstring's HEURISTIC note): common
// verbs that show up in engineering directives, chosen because they read as
// a complete, dangerous-or-notable-sounding action on their own — the shape
// a directive word ("never"/"don't") or a contrast half ("not X") most
// plausibly used to precede.
const COMMON_ACTION_VERBS = new Set([
  'commit', 'push', 'delete', 'drop', 'deploy', 'merge', 'force', 'expose',
  'hardcode', 'share', 'disable', 'skip', 'ignore', 'bypass', 'install',
  'store', 'log', 'email', 'upload', 'publish', 'revert', 'rollback',
  'override', 'grant', 'remove', 'run', 'use', 'send', 'leak', 'print',
])

// A statement that already opens with its directive/hedge word has nothing
// missing — this is what a CORRECTLY extracted (post-fix) statement looks
// like, and must never be flagged.
const LEADING_DIRECTIVE_RE =
  /^(?:never|always|don'?t|do(?:es)?\s+not|doesn'?t|you\s+should(?:n'?t)?|you\s+must(?:n'?t)?|remember\s+that|i\s+prefer|i\s+like|we\s+decided|the\s+(?:rule|convention|pattern|standard)\s+is)\b/i

function lastWord(statement: string): string {
  const trimmed = statement.trim().replace(/[.!?,;:]+$/, '')
  const m = trimmed.match(/([A-Za-z']+)$/)
  return m ? m[1].toLowerCase() : ''
}

function firstWord(statement: string): string {
  const m = statement.trim().match(/^([A-Za-z']+)/)
  return m ? m[1].toLowerCase() : ''
}

/**
 * Scan a set of statements for the two known inversion-truncation shapes.
 * Takes the minimal `{id, statement}` shape (not the full `Engram` type) so
 * it stays trivially testable and reusable from any caller that already has
 * ids and statement text (CLI, MCP, a future batch job).
 *
 * Read-only: does not touch the store, does not resolve or write anything.
 */
export function scanForInversions(
  engrams: Array<{ id: string; statement: string }>,
): InversionSuspect[] {
  const out: InversionSuspect[] = []
  for (const { id, statement } of engrams) {
    if (!statement || statement.trim().length < 8) continue

    const shapes: InversionSuspect['shapes'] = []
    const reasons: string[] = []

    const tail = lastWord(statement)
    if (tail && TAIL_FUNCTION_WORDS.has(tail)) {
      shapes.push('truncated-tail')
      reasons.push(
        `ends on "${tail}" — reads as cut off mid-clause, the shape a "not"-truncating bug leaves behind`,
      )
    }

    if (!LEADING_DIRECTIVE_RE.test(statement.trim())) {
      const head = firstWord(statement)
      if (head && COMMON_ACTION_VERBS.has(head)) {
        shapes.push('bare-imperative')
        reasons.push(
          `opens with "${head}" and no leading directive/polarity word — could be a "never/don't ${head}…" ` +
          `with the directive word stripped, or the surviving half of an "X, not Y" contrast`,
        )
      }
    }

    if (shapes.length > 0) {
      out.push({ id, statement, shapes, reason: reasons.join('; ') })
    }
  }
  return out
}
