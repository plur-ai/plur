import { extractLearnings, extractSelfReportedLearnings, isCorrection, type ProjectConfig } from '@plur-ai/core'

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
 * recall query from. Mirrors claw's `ingest()` real-time path
 * (`packages/claw/src/context-engine.ts`): `extractLearnings` over the user
 * message, persisted at confidence >= 0.7, gated behind two checks claw
 * applies before ever calling `extractLearnings`:
 *
 * - `auto_learn`: the same `config.yaml` key claw's `ContextEngine` option
 *   is named after (`packages/core/src/schemas/config.ts`, default true).
 *   Read directly off the live `Plur` instance's already-loaded config
 *   (`plur.config`) rather than re-reading the file, so a user who already
 *   set this expects — and gets — the same behaviour in both hosts.
 * - `isCorrection`: claw's real-time-ingest matcher, moved to
 *   `@plur-ai/core` (`packages/core/src/learner.ts`) so both hosts share it.
 *   Far tighter than "some pattern matched" — it requires an explicit
 *   correction shape ("no,", "actually,", "wrong", or an "X, not Y"
 *   construction).
 *
 * Before this gate (A3 audit finding), every user turn ran through
 * `extractLearnings` ungated — an opencode user had no way to turn automatic
 * engram writes off short of uninstalling the plugin.
 */
export async function learnFromUserText(plur: any, text: string, projectConfig?: ProjectConfig): Promise<void> {
  if (!text) return
  if (plur?.config?.auto_learn === false) return
  if (!isCorrection({ role: 'user', content: text })) return
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
