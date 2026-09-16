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
 *
 * Gated on `auto_learn` (D3, 2026-09 audit) — the same kill switch
 * `learnFromUserText` already respects. This is the path an attacker
 * actually has to write through: the assistant's own text is exactly the
 * text it echoes back after reading a hostile file/webpage/tool output, so
 * a self-report block ("🧠 I learned: ...") quoted FROM that content reaches
 * `learnRouted` unconditionally unless this checks first. Claw gates both of
 * its equivalent paths the same way (`packages/claw/src/context-engine.ts`,
 * `this.options.auto_learn`) — this plugin had gated only the OTHER path.
 * `claim_class: 'inferred'` (#963, D5) marks every statement this path
 * writes as the agent's own extraction rather than something a person
 * stated outright — `formatLayer3` renders that distinction
 * (`(inferred)` / `Kind: inferred`) so it never reads as user-taught.
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
 *   E4 (2026-09 audit) correction: this is NOT the same switch claw's
 *   `ContextEngine` honors, despite sharing a name. Claw's `auto_learn` is a
 *   CONSTRUCTOR OPTION (`packages/claw/src/context-engine.ts`,
 *   `this.options.auto_learn`, default `true`) — claw never reads
 *   `config.yaml` at all (`grep -rn plur.config packages/claw/src` returns
 *   nothing). A user who sets `auto_learn: false` in `~/.plur/config.yaml`
 *   gets it honored HERE, in opencode, and silently IGNORED in claw — the
 *   opposite of the "expects and gets the same behaviour in both hosts"
 *   this comment used to (incorrectly) claim. That mismatch is a real gap,
 *   tracked separately; fixing it means changing claw's behaviour (reading
 *   `config.yaml` there too, or exposing the option some other way), which
 *   is out of scope for this plugin and not done here.
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
      // #963, D5: the STATEMENT is this plugin's own regex extraction from
      // the user's text, not a verbatim quote of what they typed — the same
      // "I worked this out" reading `claim_class: 'inferred'` exists for.
      // Renders as `(inferred)` / `Kind: inferred` in formatLayer3 so it is
      // never mistaken for something explicitly taught (e.g. via plur_learn).
      claim_class: 'inferred',
    })
  }
}
