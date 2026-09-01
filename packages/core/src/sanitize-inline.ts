/**
 * One-line-ness for text that gets rendered into an agent's context.
 *
 * ## Why this exists
 *
 * An engram is rendered as `[<id>] <statement>` and the rendered engrams are
 * joined with a newline. Two consumers paste the result straight into a model's
 * context:
 *
 *   - `plur_session_start` / `plur_inject` (packages/mcp/src/tools.ts) wrap it
 *     in `## DIRECTIVES` and hand it over with no further processing.
 *   - dsh's memory-section `flatten()` splits it on the ENTRY boundary
 *     (newline followed by an open bracket) before collapsing anything.
 *
 * Neither can defend itself. The MCP path has no defence at all, and dsh's
 * split cannot distinguish a boundary the renderer wrote from one that arrived
 * inside an engram's own text. So a line terminator in any rendered field is a
 * structural forgery primitive: it mints a second engram at system-prompt
 * authority (#940), or opens a heading the plugin appears to have written.
 *
 * The guarantee therefore has to be made where the block is assembled, and it
 * has to hold for every field the renderer emits -- statement, summary,
 * rationale, domain, and the EXPIRED marker's date -- not just the statement
 * (#1003). Making it at the RENDER boundary rather than only at the write
 * boundary is what covers engrams that never went through `learn()`: pack
 * content, remote-store rows, importer output, and everything already sitting
 * in a user's store from before any of this existed (#1004).
 *
 * ## What it does, and deliberately does not do
 *
 * Collapses every character a renderer treats as a line break into a single
 * space. The set matches dsh's `LINE_BREAKS` exactly, so the two layers agree
 * on what a line break is; a lone CR is one to every renderer, and so are
 * U+2028, U+2029, U+0085 and the C0 separators.
 *
 * It collapses to a SPACE, never to nothing: welding `alpha` and `beta` into
 * `alphabeta` would silently corrupt meaning to buy no safety.
 *
 * It does NOT strip zero-width and bidi formatting characters, though dsh's
 * flatten() does. Once every line break is gone, field content can never begin
 * a line -- it is always preceded by `[<id>] ` or `  Rationale: ` -- so a
 * zero-width space followed by a hash cannot open a heading, and stripping
 * U+200E/U+200F would corrupt legitimate right-to-left text for no security
 * gain. The narrower transform is the one that holds the invariant.
 */

/**
 * Code points every renderer treats as a line break.
 *
 * Listed as code points rather than written into a regex literal so the source
 * stays pure ASCII: a literal CR or U+2028 in a source file is precisely the
 * kind of thing an editor, a linter autofix or git autocrlf silently rewrites,
 * and the rewrite would widen the hole this module exists to close without
 * failing anything.
 *
 * Kept in step with `LINE_BREAKS` in packages/dsh/src/memory-section.ts. If one
 * changes, change both: a character this layer lets through and dsh splits on
 * is exactly the gap the invariant exists to close.
 */
export const LINE_BREAK_CODE_POINTS: readonly number[] = [
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

/** Character class source for {@link LINE_BREAKS}, as `\uXXXX` escapes. */
const LINE_BREAK_CLASS =
  '[' + LINE_BREAK_CODE_POINTS.map(c => '\\u' + c.toString(16).padStart(4, '0')).join('') + ']+'

/**
 * Every character a renderer treats as a line break.
 *
 * Module-private on purpose. It carries the `g` flag, which makes `.test()`
 * stateful through `lastIndex` — safe for the `.replace()` below, a trap for
 * any caller that reaches for it. Consumers that need the SET get
 * {@link LINE_BREAK_CODE_POINTS}, which cannot carry state.
 */
const LINE_BREAKS = new RegExp(LINE_BREAK_CLASS, 'g')

/**
 * Collapse `text` to a single line, safe to interpolate into a rendered block.
 *
 * @param text - a field about to be rendered into agent context.
 * @returns the same content on one line, unable to forge block structure.
 */
export function sanitizeInline(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(/ {2,}/g, ' ').trim()
}

/**
 * `sanitizeInline` for a value that may not be a string.
 *
 * Rendered fields are typed as strings but reach the renderer from YAML on
 * disk, a remote store and third-party packs. A field that arrives as a number
 * or an object would otherwise throw inside `.replace` at injection time, which
 * turns a malformed engram into a failed session rather than a rendered one.
 *
 * @param value - the field value, of unknown provenance and type.
 * @returns the sanitized string, or `undefined` when there is nothing to render.
 */
export function sanitizeInlineOptional(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return sanitizeInline(typeof value === 'string' ? value : String(value))
}
