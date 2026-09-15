import { extractLearnings, extractSelfReportedLearnings, type ProjectConfig } from '@plur-ai/core'

/**
 * Primary learning path: harvest the assistant's own `🧠 I learned:`
 * self-report block from the turn's accumulated text and persist each
 * bullet. Mirrors claw's `afterTurn` self-report path
 * (`packages/claw/src/context-engine.ts`) — same extraction, same
 * `LearnContext` shape, an opencode-specific `source`.
 *
 * The brief's original design called `extractLearnings` with
 * `role: 'assistant'`, which `extractLearnings` always skips (it only
 * processes `role === 'user'` messages) — that would have returned `[]` on
 * every turn, forever. `extractSelfReportedLearnings` is the function claw
 * actually uses for assistant self-reports; it does not filter by role, so
 * the caller decides what to pass in.
 */
export async function learnFromTurn(plur: any, texts: string[], projectConfig?: ProjectConfig): Promise<void> {
  const statements = extractSelfReportedLearnings({ role: 'assistant', content: texts.join('\n') })
  for (const statement of statements) {
    await plur.learnRouted(statement, {
      type: 'behavioral',
      scope: projectConfig?.scope,
      domain: projectConfig?.domain,
      source: 'opencode:self-report',
      rationale: 'self-reported by agent via learning section',
      tags: ['self-report'],
    })
  }
}

/**
 * Secondary learning path: regex-based correction/preference extraction from
 * the user's own turn text — the same text `chat.message` already builds its
 * recall query from. Mirrors claw's `afterTurn` fallback path
 * (`extractLearnings` over user messages, persisted at confidence >= 0.7).
 */
export async function learnFromUserText(plur: any, text: string, projectConfig?: ProjectConfig): Promise<void> {
  if (!text) return
  const candidates = extractLearnings([{ role: 'user', content: text }])
  for (const candidate of candidates) {
    if (candidate.confidence < 0.7) continue
    await plur.learnRouted(candidate.statement, {
      type: candidate.type,
      scope: projectConfig?.scope,
      domain: projectConfig?.domain,
      source: 'opencode:chat.message',
      rationale: 'extracted from conversation via pattern matching',
      tags: [candidate.type],
    })
  }
}
