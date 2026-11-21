/**
 * Statement sanitisation shared by every write path.
 * - Attack: `dsh`'s `flatten()` splits entries on a line terminator followed by `[`,
 *   so such a statement forges a second entry at system-prompt authority.
 * - Lives in core because not every route enters `Plur.learn()` (`learnRouted`'s remote
 *   post and outbox fallback do not); every route must call it.
 * - The character class matches the renderer's byte for byte, never narrower, so it
 *   stays correct when either side changes.
 */

/**
 * A line-terminator run plus hugging spaces/tabs. The class (CR, LF, LS, PS, NEL, VT,
 * FF, the four information separators) is the same set the MCP-side sanitiser uses,
 * so they cannot drift. Absorbing adjacent spaces confines the rewrite locally.
 */
const SPACES_AROUND_TERMINATORS =
  /[ \t]*[\r\n\u2028\u2029\u0085\u000b\u000c\u001c-\u001f]+[ \t]*/g

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
  // Consume only spaces and tabs adjacent to a terminator run, so legitimate
  // multi-space content (aligned or code-like text) is left unchanged.
  return statement
    .replace(SPACES_AROUND_TERMINATORS, ' ')
    .trimEnd()
}
