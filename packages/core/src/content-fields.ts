/**
 * What the leak guard scans, defined once.
 *
 * There used to be two lists that had to agree and nothing making them.
 * `LearnContext` said what a caller may supply on a write; a hand-kept list in
 * `_engramContextFields` said what the reconstruct-from-engram guards — explicit
 * update, rescope, outbox flush, meta save — look at. The pair drifted three
 * times (#381, #405, and the review of #1002): the provenance work added
 * `attribution`, `claim_class` and `license` to the first and not the second,
 * so an AWS key written into `attribution.asserted_by` at a local scope
 * rescoped cleanly into `project:acme`, while the same key in `tags` was
 * refused.
 *
 * Two rules now, and a test that holds them:
 *
 *  - The write-time HARD scan (`detectSecrets`, throws) covers every
 *    `LearnContext` field classified `content` in the table below. The table
 *    is checked against the interface by the compiler, so a field added to
 *    `LearnContext` without a row here is a type error, not a silent gap.
 *
 *  - The engram-side scans do not enumerate at all. `engramContentFields`
 *    serialises EVERYTHING on the engram except the statement (which every
 *    caller scans separately) and PLUR's own `_`-prefixed bookkeeping keys in
 *    `structured_data`, so a field that reaches the engram by any route is
 *    scanned by construction — the same reasoning `scanPrivacy` applied to
 *    pack export after #389.
 *
 * `test/leak-surface.test.ts` walks the table with a canary in each content
 * field and checks that both engram constructors (`learn()` and
 * `_buildEngramShape`) put it where `engramContentFields` can see it.
 */
import type { LearnContext } from './types.js'
import type { Engram } from './schemas/engram.js'

/**
 * How the write-time guard treats each `LearnContext` field.
 *
 *   'content' — caller-supplied text that lands on the engram; scanned.
 *   'control' — an enumerated or structural value (a scope, a type, a date,
 *               a flag, a session key that is never persisted); not text.
 *
 * `satisfies Record<keyof LearnContext, …>` is what makes this a single
 * definition: a key missing from this object, or one that is not on the
 * interface, fails `tsc`.
 */
export const LEARN_CONTEXT_FIELD_ROLES = {
  type: 'control',
  scope: 'control',
  visibility: 'control',
  commitment: 'control',
  memory_class: 'control',
  pinned: 'control',
  valid_from: 'control',
  valid_until: 'control',
  session: 'control',
  domain: 'content',
  source: 'content',
  tags: 'content',
  rationale: 'content',
  knowledge_anchors: 'content',
  dual_coding: 'content',
  abstract: 'content',
  derived_from: 'content',
  locked_reason: 'content',
  // Becomes `provenance.origin` (`session:<id>`) — free text on the engram.
  session_episode_id: 'content',
  supersedes: 'content',
  measured_under: 'content',
  // #1002: who said it, what kind of claim it is, and the licence, which lands
  // in `provenance.license`.
  attribution: 'content',
  claim_class: 'content',
  license: 'content',
} as const satisfies Record<keyof LearnContext, 'content' | 'control'>

/** The `LearnContext` keys the write-time hard scan reads. */
export const LEARN_CONTENT_FIELDS = (Object.keys(LEARN_CONTEXT_FIELD_ROLES) as Array<keyof LearnContext>)
  .filter(k => LEARN_CONTEXT_FIELD_ROLES[k] === 'content')

/**
 * The caller-supplied text of a write, for the hard secret scan.
 *
 * Returns undefined when the context carries no content field, so a
 * statement-only write scans exactly the statement.
 */
export function learnContextContent(context: LearnContext | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined
  const out: Record<string, unknown> = {}
  for (const key of LEARN_CONTENT_FIELDS) {
    const value = (context as Record<string, unknown>)[key]
    if (value != null) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Everything on an engram that a scan should read, apart from the statement.
 *
 * Serialised, not enumerated: every field present on the engram is included,
 * so a new field cannot be missed. The one exclusion is deliberate —
 * PLUR-internal bookkeeping keys in `structured_data` (underscore-prefixed:
 * `_outbox`, `_routed`, `_demoted`, `_rescoped_from`, …) are system-generated,
 * never user content, and legitimately carry the very host topology the infra
 * detector flags (`_outbox.target_url` is `http://127.0.0.1:<port>`). Scanning
 * them would falsely demote every remote-origin or auto-routed engram on
 * update.
 *
 * Returns undefined when nothing but the statement is present, so a caller's
 * scan text stays statement-only in that case.
 */
export function engramContentFields(engram: Engram): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(engram as Record<string, unknown>)) {
    if (k === 'statement' || v == null) continue
    if (k === 'structured_data') {
      if (typeof v === 'object' && !Array.isArray(v)) {
        const userSd: Record<string, unknown> = {}
        for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
          if (!sk.startsWith('_')) userSd[sk] = sv
        }
        if (Object.keys(userSd).length > 0) fields.structured_data = userSd
      } else {
        fields.structured_data = v
      }
      continue
    }
    fields[k] = v
  }
  return Object.keys(fields).length > 0 ? fields : undefined
}
