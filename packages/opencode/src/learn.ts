import { extractLearnings, extractSelfReportedLearnings, isCorrection, type ProjectConfig } from '@plur-ai/core'

/**
 * Primary learning path: persist each bullet of the assistant's own
 * `🧠 I learned:` block, mirroring claw's `afterTurn`
 * (`packages/claw/src/context-engine.ts`). Uses `extractSelfReportedLearnings`
 * (`extractLearnings` only reads user messages).
 * Gated on `auto_learn`: assistant text can echo hostile file/web/tool content,
 * so this is the path an attacker writes through. Writes `claim_class:
 * 'inferred'` so `formatLayer3` never presents it as user-taught.
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
 * Secondary learning path: `extractLearnings` over the user's own turn text,
 * persisted at confidence >= 0.7, mirroring claw's `ingest()`
 * (`packages/claw/src/context-engine.ts`). Two gates:
 * - `auto_learn` from the live `plur.config` (`~/.plur/config.yaml`, default
 *   true). Not claw's switch of the same name, which is a constructor option.
 * - `isCorrection` (`packages/core/src/learner.ts`): requires an explicit
 *   correction shape ("no,", "actually,", "wrong", or "X, not Y").
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
