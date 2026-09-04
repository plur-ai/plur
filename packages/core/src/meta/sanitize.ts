// packages/core/src/meta/sanitize.ts

/**
 * Sanitize a string for safe LLM prompt interpolation.
 *
 * This is NOT the line-terminator fold — that is `collapseLineTerminators` in
 * `../sanitize.ts`, the one definition every write path and render path
 * shares. This helper is narrower on purpose: it keeps single newlines because
 * meta-engram TEMPLATES are legitimately multi-line, and it does the things the
 * fold does not (fence escape, role-prefix defusing, length cap). Callers that
 * render a per-engram `[id] statement` LINE fold first, then call this.
 */
export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/```/g, '~~~')               // Prevent markdown code block escape
    .replace(/\n{3,}/g, '\n\n')           // Collapse excessive newlines
    .replace(/^(system|assistant|user):/gim, '$1 -') // Prevent role injection
    .slice(0, 2000)                        // Cap length
}
