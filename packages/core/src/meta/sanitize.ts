// packages/core/src/meta/sanitize.ts

/** Sanitize a string for safe LLM prompt interpolation */
export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/```/g, '~~~')               // Prevent markdown code block escape
    .replace(/\n{3,}/g, '\n\n')           // Collapse excessive newlines
    .replace(/^(system|assistant|user):/gim, '$1 -') // Prevent role injection
    .slice(0, 2000)                        // Cap length
}
