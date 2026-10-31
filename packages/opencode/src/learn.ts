import { extractLearnings, extractSelfReportedLearnings, isCorrection, type ProjectConfig } from '@plur-ai/core'

/**
 * Primary learning path: harvest the assistant's own `🧠 I learned:`
 * self-report block from the turn's accumulated text and persist each
 * bullet. Mirrors claw's `afterTurn` self-report path
 * (`packages/claw/src/context-engine.ts`) — same extraction, same
 * `LearnContext` shape, an opencode-specific `source`.
 *
 * Uses `extractSelfReportedLearnings`, not `extractLearnings`: the latter
 * only processes `role === 'user'` messages and would return `[]` here.
 *
 * Gated on `auto_learn`, the same kill switch `learnFromUserText` respects.
 * This is the path an attacker has to write through: the assistant's own
 * text is what it echoes back after reading a hostile file/webpage/tool
 * output, so a self-report block quoted FROM that content would reach
 * `learnRouted` unless this checks first. Claw gates its equivalent paths
 * the same way.
 * `claim_class: 'inferred'` marks every statement this path writes as the
 * agent's own extraction rather than something a person stated outright —
 * `formatLayer3` renders that distinction (`(inferred)` / `Kind: inferred`)
 * so it never reads as user-taught.
 */
export async function learnFromTurn(plur: any, texts: string[], projectConfig?: ProjectConfig): Promise<void> {
  if (plur?.config?.auto_learn === false) return
  const statements = extractSelfReportedLearnings({ role: 'assistant', content: texts.join('\n') })
  for (const statement of statements) {
    await plur.learnRouted(statement, {
      type: 'behavioral',
      scope: projectConfig?.scope,
      domain: projectConfig?.domain,
      source: 'opencode:self-report',
      rationale: 'self-reported by agent via learning section',
      tags: ['self-report'],
      claim_class: 'inferred',
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
 * - `auto_learn`: read directly off the live `Plur` instance's already-loaded
 *   config (`plur.config`, from `~/.plur/config.yaml` —
 *   `packages/core/src/schemas/config.ts`, default true).
 *
 *   This is NOT the same switch claw's `ContextEngine` honors, despite
 *   sharing a name: claw's `auto_learn` is a constructor option and claw
 *   does not read `config.yaml`. A user who sets `auto_learn: false` in
 *   `~/.plur/config.yaml` gets it honored here but not in claw.
 * - `isCorrection`: claw's real-time-ingest matcher, moved to
 *   `@plur-ai/core` (`packages/core/src/learner.ts`) so both hosts share it.
 *   Far tighter than "some pattern matched" — it requires an explicit
 *   correction shape ("no,", "actually,", "wrong", or an "X, not Y"
 *   construction).
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
      // The statement is this plugin's own regex extraction from the user's
      // text, not a verbatim quote of what they typed. Renders as
      // `(inferred)` / `Kind: inferred` in formatLayer3 so it is never
      // mistaken for something explicitly taught (e.g. via plur_learn).
      claim_class: 'inferred',
    })
  }
}
