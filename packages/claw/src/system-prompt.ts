import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { upsertInstructionSection, writeWithBackup, SHIPPED_CLAW_SECTIONS } from '@plur-ai/core'

/**
 * The PLUR memory section appended to SYSTEM.md during plugin installation.
 * Teaches the agent how to use PLUR tools and the learning format.
 *
 * Kept in sync with CLI init CLAUDE.md section and MCP init CLAUDE.md section.
 * When updating, bump the version marker at the bottom.
 */
export const PLUR_SYSTEM_SECTION = `

## PLUR Memory System

You have persistent memory powered by PLUR. Corrections, preferences, and conventions persist across sessions as engrams.

### Session Workflow

1. **Start**: Call \`plur.recall\` with the task description — check if you already know something relevant
2. **Learn**: When corrected or discovering something new, call \`plur.learn\` immediately
3. **Recall**: Before answering factual questions, call \`plur.recall\` — the answer may be in memory
4. **Feedback**: Rate memories with \`plur.feedback\` (positive/negative) — trains relevance
5. **End**: Record a session summary with \`plur.capture\`

Do not ask permission to use these tools — they are your memory system.

### Your Memory Tools

Use these tools proactively, not just when asked:

- **plur.recall** — Search memories BEFORE answering questions. Do not start from scratch.
- **plur.learn** — Store knowledge worth remembering: corrections, preferences, decisions, project facts. Phrase as factual statements.
- **plur.ingest** — Extract durable knowledge from content (books, articles, documents). Creates multiple memories from key insights.
- **plur.forget** — Retire memories that are no longer accurate.
- **plur.feedback** — Rate a memory as positive, negative, or neutral. Improves future recall.
- **plur.capture** — Record a session event in the episodic timeline.
- **plur.timeline** — Query past episodes by time, agent, or channel.
- **plur.status** — Check memory health (engram count, storage).

### Knowledge Packs

Knowledge Packs are curated collections of engrams for specific domains — shareable with teams.

- **plur.packs.list** — List installed packs with integrity hashes
- **plur.packs.install** — Install a pack (reports conflicts with existing memories)
- **plur.packs.uninstall** — Remove a pack and its engrams
- **plur.packs.export** — Export your memories as a thematic pack (with privacy scan)

When a user asks about sharing knowledge, team memory, or domain expertise — suggest knowledge packs.

Export packs thematically: filter by domain, tags, or type. Privacy scan automatically blocks secrets and private memories.

### When to Check Memory

Before reaching for web search, file reads, or guessing:
1. Is the answer in memory? → \`plur.recall\`
2. Is the answer in the filesystem? → Read/Grep/Glob
3. Is the answer derivable from loaded context? → Just answer
4. Only if 1-3 fail → Use external tools

| Domain | When to recall |
|--------|----------------|
| Decisions | Past design choices, architecture rationale |
| Corrections | API quirks, bugs, wrong assumptions |
| Preferences | Formatting, tone, workflow, tool choices |
| Conventions | Tag formats, file routing, naming rules |

### When Corrected

When the user corrects you ("no, use X not Y", "that's wrong"):
1. Call \`plur.learn\` immediately — before continuing the task
2. Call \`plur.feedback\` with negative signal on the wrong memory if one was used
3. Then continue with the corrected approach

### Verification

When recalling facts that will drive actions:
1. State the recalled fact explicitly before acting on it
2. If no memory matches, say so and verify from the filesystem
3. Never interpolate between two memories to produce a "probably correct" composite

### Signaling New Learnings

When you learn something durable from a conversation, end your response with:

---
I learned:
- [concise factual statement]
- [another if applicable]

Guidelines:
- Only genuine learnings, not conversation summaries
- Skip this section if nothing new was learned
- Phrase as facts: "The API requires auth header" not "the user said the API needs auth"
- Include corrections to your own mistakes

### Memory Line on Every Reply

End every reply with one short line: \`Memory — recalled N · used: ENG-…, ENG-… · written: ENG-…\` (recalled as a count; used and written as ids only, no statements), or \`Memory — none\`. Only count/list ids you actually saw this turn; never invent an id. Give details only if the user asks.

### Principles

- **Memory over repetition** — learn once, recall always. Never ask the user to repeat themselves.
- **Do not start from scratch** — check your memories before answering.
- **Augment, do not replace** — you assist, the human decides.

<!-- plur-instructions-v4 -->
`

/** The heading line that opens the section (matched as a whole line). */
const PLUR_HEADING = '## PLUR Memory System'

/** The current version marker, on a line of its own at the end of the section. */
const PLUR_VERSION_MARKER = '<!-- plur-instructions-v4 -->'

export interface EnsureSystemPromptResult {
  appended: boolean
  updated: boolean
  path: string
  /** Backup of SYSTEM.md written before it was changed, if it existed. */
  backup?: string
  /** Sections under the PLUR heading that PLUR did not write, left untouched. */
  keptSections: number
}

/**
 * Append or update PLUR memory instructions in SYSTEM.md, through core's
 * `upsertInstructionSection` (the same logic as `plur init`):
 * - creates the file if it does not exist
 * - appends if no PLUR section is present
 * - replaces an older section only when it is, whitespace aside, a text PLUR
 *   shipped; a section the user wrote or edited is kept as it is and the new
 *   one is added beside it (#1520 audit B2, N5)
 * - leaves a file with a current section unchanged
 * The heading is matched as a whole line outside code fences, so a user's
 * `## PLUR Memory System Guardrails` or `### PLUR Memory System` is not it.
 * SYSTEM.md is copied to a timestamped backup before any change.
 */
export function ensureSystemPrompt(workspacePath: string): EnsureSystemPromptResult {
  const systemMdPath = join(workspacePath, 'SYSTEM.md')
  if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true })

  const existing = existsSync(systemMdPath) ? readFileSync(systemMdPath, 'utf8') : null
  const r = upsertInstructionSection(existing, {
    section: PLUR_SYSTEM_SECTION,
    heading: PLUR_HEADING,
    marker: PLUR_VERSION_MARKER,
    shipped: SHIPPED_CLAW_SECTIONS,
  })
  if (r.status === 'already') {
    return { appended: false, updated: false, path: systemMdPath, keptSections: r.keptSections }
  }
  const backup = writeWithBackup(systemMdPath, r.content) ?? undefined
  return {
    appended: r.status === 'created' || r.status === 'added',
    updated: r.status === 'upgraded',
    path: systemMdPath,
    backup,
    keptSections: r.keptSections,
  }
}
