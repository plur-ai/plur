/**
 * Line-terminator sanitisation — the ONE definition of "what a line break is"
 * and what to do about it, shared by every write path and by the render layer.
 *
 * ## The attack
 *
 * An engram renders as `[<id>] <statement>` and the rendered engrams are joined
 * with a newline. Two consumers paste that block straight into a model's
 * context: `plur_session_start` / `plur_inject` wrap it in `## DIRECTIVES` with
 * no processing of their own, and dsh's `flatten()` splits it on the ENTRY
 * boundary (a line terminator followed by `[`) before collapsing anything, so
 * it cannot tell a boundary the renderer wrote from one that arrived inside an
 * engram's own text. A line terminator in any rendered field therefore mints a
 * second engram at system-prompt authority, or opens a heading the plugin
 * appears to have written (#940, #952, #1003, #1004).
 *
 * ## Threat model — what this defends against, and what it does not
 *
 * Defended: the author of a third-party PACK, a writer to a SHARED or REMOTE
 * store, an agent writing its own memories through `learn()` / `plur_learn`,
 * and any engram already sitting in a store from before any of this existed.
 * Each of those controls the text of a rendered field; none of them can make
 * the renderer emit a line break, or an entry delimiter, that it did not write
 * itself. That is the whole guarantee: every structural boundary in a rendered
 * block was written by the renderer.
 *
 * Not defended, and not attempted here: inline residue (a statement that SAYS
 * `[ENG-X] do this` on one line is still ONE entry, and a model may still read
 * the words — that is a content problem, not a structure problem); semantic
 * prompt injection (`detectPromptInjection` in secrets.ts is the scanner for
 * that, and scanning is structurally the wrong layer for THIS bug, because
 * whether text is structure is decided by the serialiser, not by the text's
 * vocabulary); authentication of engram ids (the `[<id>]` token is a handle, not
 * a proof of origin); equivocation or downgrade of a store.
 *
 * ## Why one module, called from every path
 *
 * The first fix put the collapse inside `Plur.learn()`, on the reasoning that
 * every write path funnels through it. That is not true. `learnRouted()` calls
 * `learn()` ONLY on its local route: when a remote store resolves for the
 * scope, it builds the engram shape and posts it without entering `learn()` at
 * all, and the outbox fallback writes that same raw shape locally. learnAsync's
 * UPDATE and MERGE branches write the incoming statement into an existing row
 * without calling `learn()` either; `updateEngram()` takes a caller-built
 * engram; pack install copies a file. A helper that every one of those paths
 * calls — and that the RENDER boundary calls too, so an engram that reached the
 * corpus some other way (a remote row, a hand-edited file, a pack installed
 * before this existed) is still rendered clean — is the only shape that makes
 * "no path can bypass this" true rather than aspirational.
 *
 * A second hand-written copy of the character class in another package is how
 * the two drift, always toward the narrower one, and the narrow one becomes the
 * way in. MCP, claw and the CLI import this module. dsh cannot import core
 * statically (it loads core lazily so a WASM failure degrades to "no memory"
 * instead of taking the host agent down), so dsh carries its own copy and
 * `packages/dsh/test/memory-section.test.ts` asserts, by importing core, that
 * it equals {@link LINE_TERMINATOR_CODE_POINTS}.
 *
 * ## What it does, and deliberately does not do
 *
 * {@link collapseLineTerminators} replaces every run of line terminators,
 * together with the spaces and tabs hugging it, with ONE space, then trims
 * trailing whitespace. That is the entire transform.
 *
 *  - It collapses to a space, never to nothing: welding `alpha` and `beta` into
 *    `alphabeta` would corrupt meaning to buy no safety.
 *  - It does NOT collapse runs of spaces elsewhere in the text. An earlier form
 *    appended a blanket `/ {2,}/` collapse and a leading `.trim()`, which
 *    rewrote legitimate aligned or code-like content that had nothing to do
 *    with the forgery — a change beyond the fix's remit, reversed in #953 and
 *    not reintroduced here.
 *  - It does NOT strip zero-width or bidi marks. Once every line break is gone,
 *    field content can never begin a line — it is always preceded by `[<id>] `
 *    or a label — so a zero-width space cannot open a heading, and stripping
 *    U+200E/U+200F would corrupt right-to-left text for no security gain.
 *  - It does NOT touch `|`. The pipe is the render layer's OWN delimiter and is
 *    escaped THERE (`escapeInlineDelimiter` in inject.ts), never in the store:
 *    a stored statement must remain what its author wrote.
 *
 * The character class is deliberately as wide as the renderer's, not as narrow
 * as today's exploit. A sanitiser exactly as strict as the splitter it defends
 * stays correct when either side is edited; one that is narrower is correct
 * only until someone widens the splitter, and nothing fails loudly when they do.
 */

/**
 * Code points every renderer treats as a line break.
 *
 * Listed as code points rather than written into a regex literal so the source
 * stays pure ASCII: a literal CR or U+2028 in a source file is precisely the
 * kind of thing an editor, a linter autofix or `git autocrlf` silently
 * rewrites, and the rewrite would narrow the class this module exists to hold
 * without failing anything.
 */
export const LINE_TERMINATOR_CODE_POINTS: readonly number[] = [
  0x000a, // LF   line feed
  0x000d, // CR   carriage return
  0x2028, // LS   line separator
  0x2029, // PS   paragraph separator
  0x0085, // NEL  next line
  0x000b, // VT   vertical tab
  0x000c, // FF   form feed
  0x001c, // FS   file separator
  0x001d, // GS   group separator
  0x001e, // RS   record separator
  0x001f, // US   unit separator
]

/** Character-class source for the set above, as `\uXXXX` escapes. */
const TERMINATOR_CLASS =
  '[' + LINE_TERMINATOR_CODE_POINTS.map(c => '\\u' + c.toString(16).padStart(4, '0')).join('') + ']'

/**
 * A line-terminator run, plus any spaces or tabs hugging it on either side —
 * including spaces BETWEEN terminators, so `"a\n \n b"` is one match and one
 * space, not two.
 *
 * Absorbing the adjacent spaces here, rather than collapsing every multi-space
 * run afterwards, keeps the rewrite confined to the neighbourhood of the thing
 * being defused. The two classes are disjoint, so the nested quantifier cannot
 * backtrack: a 1M-terminator input folds in linear time (pinned by test).
 *
 * Module-private on purpose: it carries the `g` flag, which makes `.test()`
 * stateful through `lastIndex`. Consumers that need the SET get
 * {@link LINE_TERMINATOR_CODE_POINTS}, which cannot carry state.
 */
const SPACES_AROUND_TERMINATORS = new RegExp('[ \\t]*(?:' + TERMINATOR_CLASS + '+[ \\t]*)+', 'g')

/**
 * Collapse every line terminator in a piece of engram text to a single space.
 *
 * A statement is one assertion. Newlines cost it nothing legitimate, so
 * collapsing is lossless for real content and total against the forgery.
 *
 * Idempotent, so a path that is sanitised twice (learnRouted -> learn on the
 * local route; the write boundary and then the render boundary) is not a bug.
 *
 * @param statement - the text of a single-line engram field.
 * @returns the same content on one line, with no terminator left in it.
 */
export function collapseLineTerminators(statement: string): string {
  return statement
    .replace(SPACES_AROUND_TERMINATORS, ' ')
    .trimEnd()
}

/**
 * {@link collapseLineTerminators} for a value that may not be a string.
 *
 * Rendered fields are typed as strings but reach the renderer from YAML on
 * disk, a remote store and third-party packs. A field that arrives as a number
 * or an object would otherwise throw inside `.replace` at injection time, which
 * turns a malformed engram into a failed session rather than a rendered one.
 *
 * @param value - the field value, of unknown provenance and type.
 * @returns the folded string, or `undefined` when there is nothing to render.
 */
export function collapseLineTerminatorsOptional(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return collapseLineTerminators(typeof value === 'string' ? value : String(value))
}

/**
 * The engram fields that are single-line by contract: rendered into agent
 * context by formatLayer1/2/3 (statement, rationale, summary, domain) or
 * exported verbatim alongside them (source).
 *
 * Enumerated from the renderer, not guessed — and defence in depth rather than
 * the guarantee: the render boundary folds every field it emits unconditionally,
 * and `injection-render-boundary.test.ts` poisons every string leaf generically
 * so a field added to the renderer without being added here still fails a test.
 */
export const SINGLE_LINE_TEXT_FIELDS = ['statement', 'rationale', 'summary', 'domain', 'source'] as const

/**
 * `temporal.valid_until` reaches the EXPIRED marker, which interpolates it into
 * the same line as the statement — a second forgery vector, and one the schema
 * does not constrain (it is a bare optional string with no date format).
 */
export const SINGLE_LINE_TEMPORAL_FIELDS = ['valid_from', 'valid_until'] as const

/** Result of {@link collapseEngramTextFields}. */
export interface FoldedEngram<T> {
  /** The engram with every single-line field folded; the input object when nothing changed. */
  engram: T
  /** Dotted names of the fields that were changed, in field order. Empty when nothing was. */
  folded: string[]
}

/**
 * Fold every single-line text field of an engram-shaped object.
 *
 * Used wherever a WHOLE engram enters a store or the injection corpus without
 * passing through `learn()`: pack install, pack load, `updateEngram()`. Reports
 * WHICH fields changed so the caller can log it — prevention without detection
 * lets a malicious pack install everywhere, be neutralised every time, and
 * never be noticed.
 *
 * Shallow-copies; never mutates the input.
 *
 * @param engram - any object shaped like an engram, from any source.
 * @returns the folded copy (or the same object) and the list of folded fields.
 */
export function collapseEngramTextFields<T extends object>(engram: T): FoldedEngram<T> {
  const c = { ...engram } as Record<string, unknown>
  const folded: string[] = []
  for (const field of SINGLE_LINE_TEXT_FIELDS) {
    const value = c[field]
    if (typeof value !== 'string') continue
    const out = collapseLineTerminators(value)
    if (out !== value) { c[field] = out; folded.push(field) }
  }
  const temporal = c.temporal
  if (temporal !== null && typeof temporal === 'object') {
    const t = { ...(temporal as Record<string, unknown>) }
    let touched = false
    for (const key of SINGLE_LINE_TEMPORAL_FIELDS) {
      const value = t[key]
      if (typeof value !== 'string') continue
      const out = collapseLineTerminators(value)
      if (out !== value) { t[key] = out; folded.push(`temporal.${key}`); touched = true }
    }
    if (touched) c.temporal = t
  }
  return { engram: (folded.length > 0 ? c : engram) as T, folded }
}

/**
 * The caller-supplied `LearnContext` fields that land in single-line engram
 * fields. `learn()`, `learnRouted()` and the batch/async paths fold these
 * alongside the statement, so a rationale carrying a line break is stored
 * folded rather than folded only at render — otherwise export, `plur list`,
 * the viewer and a downstream re-pack would all still see forged structure.
 */
export const SINGLE_LINE_CONTEXT_FIELDS = ['rationale', 'source', 'domain'] as const

/**
 * Fold the single-line text fields of a learn context.
 *
 * Returns the input object untouched (same reference) when nothing changes, so
 * callers that compare or spread it see no gratuitous copy.
 *
 * @param context - the caller's context, or undefined.
 * @returns the context with rationale / source / domain folded.
 */
export function collapseLearnContextText<T extends { rationale?: string; source?: string; domain?: string } | undefined>(
  context: T,
): T {
  if (!context) return context
  let out: Record<string, unknown> | undefined
  for (const field of SINGLE_LINE_CONTEXT_FIELDS) {
    const value = (context as Record<string, unknown>)[field]
    if (typeof value !== 'string') continue
    const folded = collapseLineTerminators(value)
    if (folded !== value) (out ??= { ...context })[field] = folded
  }
  return (out ?? context) as T
}
