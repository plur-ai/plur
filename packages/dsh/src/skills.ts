/**
 * The `plur-memory` skill, contributed at runtime.
 *
 * Registered directly on `ctx.skills` rather than through a filesystem provider,
 * so installing the plugin is the only step — nothing to copy into a skills
 * directory.
 *
 * MUST be reached through `ctx.inject(['skills'], ...)`. Cordis throws on
 * reading an undeclared service, so the guard below cannot save a caller that
 * has not declared the dependency — the property access throws first.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'

const SKILL_BODY = `Use PLUR memory deliberately.

Relevant memories are ALREADY in your system prompt, under "## DIRECTIVES" and
"## ALSO CONSIDER". You do not need to call a tool to see them, and you should not
ask the user to remind you of something that is already there.

- \`plur_recall\` — only for a targeted lookup beyond what is already shown.
- \`plur_learn\` — when the user corrects you or states a durable preference.
- \`plur_feedback\` — when an injected memory was useful, or actively misleading.
- \`plur_forget\` — when a memory is wrong or out of date. Do not leave it in place.

Memory you cannot correct is worse than no memory. If the user tells you something
stored is wrong, retire it rather than working around it.
`

/**
 * Register the skill.
 *
 * @param ctx - the Cordis context whose scope owns the registration.
 * @returns the disposer, or a no-op when the host exposes no skill registry.
 */
export function registerSkills(ctx: Context): () => void {
  const skills = (ctx as { skills?: { register?: (s: unknown) => () => void } }).skills
  if (typeof skills?.register !== 'function') return () => {}
  return skills.register({
    name: 'plur-memory',
    description: 'How to use PLUR persistent memory in this session.',
    body: SKILL_BODY,
  })
}
