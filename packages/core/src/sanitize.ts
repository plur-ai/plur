/**
 * Statement sanitisation shared by every write path.
 *
 * ## The attack
 *
 * `dsh`'s `flatten()` renders engrams into one block and splits entries on a
 * line terminator followed by an opening bracket. A statement that contains
 * that sequence therefore mints a SECOND entry when rendered — and the renderer
 * emits that block at system-prompt authority, so the forged entry is read as
 * an instruction rather than as data.
 *
 * ## Why this lives in core, in its own module
 *
 * Not every write path goes through `Plur.learn()`. `learnRouted()` calls
 * `learn()` only on its local route: when a remote store resolves for the
 * scope, it posts the engram without entering `learn()`, and the outbox
 * fallback writes the same raw shape locally. The CLI and the Python SDK both
 * go through `learnRouted`. A forged entry on a shared store reaches other
 * people's system prompts, so a helper called by every route is the only way
 * to guarantee no write path bypasses the sanitisation.
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
 * A line-terminator run, plus any spaces or tabs hugging it on either side.
 *
 * The class is CR, LF, LINE SEPARATOR, PARAGRAPH SEPARATOR, NEXT LINE, vertical
 * tab, form feed and the four information separators — the same set the
 * MCP-side sanitiser uses, so the two cannot drift into disagreeing about what
 * a line break is.
 *
 * Absorbing the adjacent spaces here, rather than collapsing every multi-space
 * run afterwards, keeps the rewrite confined to the neighbourhood of the thing
 * being defused.
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
