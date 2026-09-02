/**
 * Statement sanitisation shared by every write path.
 *
 * ## The attack
 *
 * `dsh`'s `flatten()` renders engrams into one block and splits entries on a
 * line terminator followed by an opening bracket. A statement that contains
 * that sequence therefore mints a SECOND entry when rendered — and the renderer
 * emits that block at system-prompt authority, so the forged entry is read as
 * an instruction rather than as data. #940 and #952 are the same defect reached
 * through two different doors.
 *
 * ## Why this lives in core, in its own module
 *
 * The first fix put the collapse inside `Plur.learn()`, on the reasoning that
 * every write path funnels through it. That is not true. `learnRouted()` calls
 * `learn()` ONLY on its local route: when a remote store resolves for the
 * scope, it builds the engram shape and posts it without entering `learn()` at
 * all, and the outbox fallback writes the same raw shape locally. The CLI and
 * the Python SDK both go through `learnRouted`, and a comment in the source
 * calls it the primary production write path.
 *
 * So the highest-impact variant survived that fix: `plur learn` with a forged
 * boundary, against a scope backed by a remote store, still stored and
 * propagated it — and a forged entry on a SHARED store reaches other people's
 * system prompts.
 *
 * A helper called by both routes is the only shape that makes the claim
 * "no write path can bypass this" true rather than aspirational.
 *
 * ## The character class
 *
 * Deliberately matches the renderer's own class byte for byte rather than
 * narrowing to the one character that provably forges a boundary today. A
 * sanitiser that is exactly as strict as the renderer it defends stays correct
 * when either side is edited; one that is narrower is correct only until
 * someone widens the splitter, and nothing would fail loudly when they did.
 */

/**
 * Characters the renderer treats as ending a line.
 *
 * CR, LF, LINE SEPARATOR, PARAGRAPH SEPARATOR, NEXT LINE, vertical tab, form
 * feed, and the four information separators — the same set the MCP-side
 * sanitiser uses, so the two cannot drift into disagreeing about what a line
 * break is.
 */
const LINE_TERMINATORS = /[\r\n\u2028\u2029\u0085\u000b\u000c\u001c-\u001f]+/g

/**
 * Collapse every line terminator in a statement to a single space.
 *
 * A statement is one assertion. Newlines cost it nothing legitimate, so
 * collapsing is lossless for real content and total against the forgery.
 *
 * Idempotent, so a path that is sanitised twice (learnRouted -> learn on the
 * local route) is not a bug.
 */
export function collapseLineTerminators(statement: string): string {
  return statement
    .replace(LINE_TERMINATORS, ' ')
    .replace(/ {2,}/g, ' ')
    .trimEnd()
}
