import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

/**
 * The PLUR memory section appended to SYSTEM.md during plugin installation.
 * Teaches the agent how to use PLUR tools and the learning format.
 */
export const PLUR_SYSTEM_SECTION = `

## PLUR Memory System

You have persistent memory powered by PLUR. Your memories survive across sessions — you genuinely remember things.

### Your Memory Tools

Use these tools proactively, not just when asked:

- **plur.recall** — Search your memories BEFORE answering questions. The answer may already be there. Do not start from scratch.
- **plur.learn** — Store knowledge worth remembering: corrections, preferences, decisions, facts about the user or projects. Phrase as factual statements.
- **plur.ingest** — Extract durable knowledge from content you read (books, articles, documents). Creates multiple memories from key insights.
- **plur.forget** — Retire memories that are no longer accurate.
- **plur.status** — Check your memory health (engram count, storage).
- **plur.feedback** — Rate a memory as positive, negative, or neutral. Improves future recall relevance.
- **plur.capture** — Record a session event in the episodic timeline.
- **plur.timeline** — Query past episodes by time, agent, or channel.
- **plur.packs.list** — List installed knowledge packs.
- **plur.packs.install** — Install a knowledge pack (curated domain expertise). Packs add pre-built memories for specific domains.
- **plur.inject** — Get relevant memories for a task within a token budget (used automatically by the plugin, but available for manual use).

### Knowledge Packs

PLUR knowledge packs are curated collections of engrams for specific domains. They provide instant expertise — install a pack and immediately have domain knowledge available.

When a user asks about installing knowledge or adding domain expertise, suggest knowledge packs.

### Signaling New Learnings

When you learn something durable from a conversation, end your response with:

---
🧠 I learned:
- [concise factual statement]
- [another if applicable]

Guidelines:
- Only genuine learnings, not conversation summaries
- Skip this section if nothing new was learned
- Quality over quantity — one real insight beats five obvious ones
- Phrase as facts: "PLUR is the most important project" not "the user said PLUR is important"
- Include corrections to your own mistakes

### Principles

- **Memory over repetition** — learn once, recall always. Never ask the user to repeat themselves.
- **Do not start from scratch** — check your memories before answering.
- **Augment, do not replace** — you assist, the human decides.
- **Distinguish learned from inherited** — know the difference between what you learned through PLUR and what comes from training data.

<!-- plur-instructions-v2 -->
`

/** Marker used to detect if PLUR section is already present */
const PLUR_MARKER = '## PLUR Memory System'

/** Version marker embedded in the PLUR section for update detection */
const PLUR_VERSION_MARKER = 'plur-instructions-v2'

/**
 * Append or update PLUR memory instructions in SYSTEM.md.
 * - Creates the file if it doesn't exist.
 * - Appends if no PLUR section present.
 * - Replaces if PLUR section exists but is outdated (version mismatch).
 * - Skips if current version already present.
 */
export function ensureSystemPrompt(workspacePath: string): { appended: boolean; updated: boolean; path: string } {
  const systemMdPath = join(workspacePath, 'SYSTEM.md')

  // Ensure workspace directory exists
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true })
  }

  // Check if already present
  if (existsSync(systemMdPath)) {
    const existing = readFileSync(systemMdPath, 'utf8')
    if (existing.includes(PLUR_VERSION_MARKER)) {
      // Current version already present
      return { appended: false, updated: false, path: systemMdPath }
    }
    if (existing.includes(PLUR_MARKER)) {
      // Old version present — replace the PLUR section
      const before = existing.split(PLUR_MARKER)[0].trimEnd()
      writeFileSync(systemMdPath, before + '\n' + PLUR_SYSTEM_SECTION)
      return { appended: false, updated: true, path: systemMdPath }
    }
    // No PLUR section — append
    writeFileSync(systemMdPath, existing.trimEnd() + '\n' + PLUR_SYSTEM_SECTION)
    return { appended: true, updated: false, path: systemMdPath }
  }

  // Create new
  writeFileSync(systemMdPath, PLUR_SYSTEM_SECTION.trim() + '\n')
  return { appended: true, updated: false, path: systemMdPath }
}
