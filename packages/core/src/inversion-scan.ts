/**
 * Heuristic, READ-ONLY detector for engrams whose statement may have lost its
 * negation during extraction (`CORRECTION_PATTERNS` / `PREFERENCE_PATTERNS` in
 * `learner.ts`). Such an engram is a confident standing instruction meaning
 * the OPPOSITE of what was said ("never commit the API key" stored as "commit
 * the API key"). Stores synced from other machines can carry them too.
 * Neither `plur tensions` (contradictions between TWO engrams) nor the
 * secret/sensitivity scanners look for this shape.
 *
 * This module only REPORTS suspects. It never rewrites an engram: a truncated
 * fragment cannot be reliably reconstructed (which word was dropped? was there
 * ever a negation?), and guessing wrong would corrupt the memory a second
 * time. A human reviews each suspect: fix it by hand, retire it, or confirm a
 * false positive (clean statements can end in a preposition or start with a
 * bare verb).
 *
 * HEURISTIC, NOT PROOF. Every check matches the SURVIVING text, so it both
 * misses real inversions ("use pnpm, not npm" truncated to "use pnpm" reads
 * as complete) and flags statements written in an unusual shape. The CLI's
 * `plur audit --source engrams` help text repeats this caveat for users.
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
   *   conjunction, article, or a dangling "not") — the shape
   *   `/(.+?),?\s+not\s+(.+)/i` leaves when only the text before "not" is
   *   captured.
   * - `bare-imperative`: the statement opens with a common action verb and
   *   no leading subject, hedge, or polarity word (no "never", "don't",
   *   "you should", …) — consistent with a pattern such as
   *   `(?:always|never)\s+(.+)` capturing only the tail and dropping the
   *   directive word, or with the SURVIVING half of an "X, not Y" contrast
   *   whose second half was dropped ("use pnpm" from "use pnpm, not npm").
   */
  shapes: Array<'truncated-tail' | 'bare-imperative'>
  reason: string
}

// Tail words left by `/(.+?),?\s+not\s+(.+)/i` (matched[1] only) on
// "X is/was/should/must/does/… not Y", plus connectives/articles left when a
// sentence is cut at a comma. Deliberately closed and small: only words that
// cannot legitimately end a COMPLETE standing instruction.
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

// Narrow, explicitly a guess: common verbs in engineering directives that read
// as a complete, notable action on their own — the words a dropped "never" /
// "don't" or a dropped "not X" most plausibly preceded.
const COMMON_ACTION_VERBS = new Set([
  'commit', 'push', 'delete', 'drop', 'deploy', 'merge', 'force', 'expose',
  'hardcode', 'share', 'disable', 'skip', 'ignore', 'bypass', 'install',
  'store', 'log', 'email', 'upload', 'publish', 'revert', 'rollback',
  'override', 'grant', 'remove', 'run', 'use', 'send', 'leak', 'print',
])

// A statement that already opens with its directive/hedge word has nothing
// missing — a correctly extracted statement looks like this and must never be
// flagged.
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
 * ids and statement text.
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
