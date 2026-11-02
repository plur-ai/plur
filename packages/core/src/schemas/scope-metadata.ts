import { z } from 'zod'
import { logger } from '../logger.js'

/**
 * Self-describing scope metadata: a scope can declare its purpose, coverage and
 * sensitivity policy, so the write-time leak guard decides per scope. Metadata
 * is OPTIONAL; without it a shared scope gets the blanket rule (isSharedScope +
 * detectSensitive → demote), and the `sensitivity` default reproduces that, so
 * adding metadata is non-breaking. Locally carried on a config `stores` entry
 * (packages/core/src/schemas/config.ts).
 */

/** Categories of sensitive content a scope can forbid or explicitly allow.
 *  These map 1:1 to the detector families in secrets.ts:
 *    - 'secrets' → detectSecrets() families (api keys, tokens, passwords, …)
 *    - 'infra'   → infra topology (public IPv4/IPv6, basic-auth URLs,
 *                   host:port, internal/infra hostnames)
 *
 *  PII detection is deliberately OUT OF SCOPE: no detector maps to a 'pii'
 *  category, so a scope declaring `forbid: ['pii']` would silently protect
 *  nothing. Add it back here AND to sensitivityCategory()'s return type in
 *  secrets.ts only once a real, low-false-positive PII detector exists. */
export const SENSITIVITY_CATEGORIES = ['secrets', 'infra'] as const
export type SensitivityCategory = (typeof SENSITIVITY_CATEGORIES)[number]

/**
 * TRUST RULE: remote-served sensitivity may only TIGHTEN the leak guard, never
 * loosen it (the guard consults `allow` before `forbid`). persistScopeMetadata
 * NEVER persists a remote `allow` and persists only `forbid`, sanitized to
 * SENSITIVITY_CATEGORIES. A hand-edited local `allow` is still honored: that is
 * a local decision a remote endpoint cannot make for you.
 */
export const ScopeSensitivitySchema = z.object({
  /**
   * Sensitive categories that must NOT be written to this scope. Preprocessed
   * element-wise so a bad value never fails the whole StoreEntry parse (which
   * would drop its `url`/`token`): unknown categories are dropped with a
   * warning, and only an empty or non-array result falls to the safe default
   * (`['pii']` → `['secrets','infra']`). Enclosing-shape malformations are
   * coerced too (`allow` here, `sensitivity`/`covers` in config.ts), so
   * url/token survive ANY metadata malformation. loadConfig logs `scope=<s>`.
   */
  forbid: z.preprocess((val) => {
    if (Array.isArray(val)) {
      const bad = val.filter((c) => !SENSITIVITY_CATEGORIES.includes(c as SensitivityCategory))
      if (bad.length) {
        logger.warning(`[plur:config] dropping unknown sensitivity categor${bad.length > 1 ? 'ies' : 'y'} ${JSON.stringify(bad)} from a scope forbid list — keeping valid entries`)
      }
      const kept = val.filter((c) => SENSITIVITY_CATEGORIES.includes(c as SensitivityCategory))
      return kept.length ? kept : ['secrets', 'infra']
    }
    return ['secrets', 'infra'] // non-array (e.g. hand-edited scalar) → safe default, NOT a re-thrown Zod error
  }, z.array(z.enum(SENSITIVITY_CATEGORIES)).default(['secrets', 'infra']))
    .describe('Sensitive categories that must NOT be written to this scope. A write that trips one of these is demoted to local/private. Default reproduces Stage 1: secrets + infra are forbidden on shared scopes. Unknown categories are dropped (not fatal) so a forward/hand-edited category never drops the whole store entry.'),
  // `allow` is shape-tolerant for the same reason as `forbid`: a hand-edited
  // or forward-compat scalar (`allow: 'infra'`) or any non-array shape must
  // NOT fail the whole StoreEntry safeParse, or loadConfig drops the entry
  // incl. its url/token. A non-array coerces to the safe default `[]` (allow
  // nothing) rather than throwing.
  allow: z.preprocess((val) => (Array.isArray(val) ? val.filter((x) => typeof x === 'string') : []), z.array(z.string()).default([]))
    .describe('Detector pattern names or category names explicitly permitted on this scope, overriding `forbid`. A match whose categories are ALL allowed is not demoted (e.g. a scope that legitimately holds infra topology can allow "infra"). A non-array shape coerces to [] (not fatal) so it never drops the whole store entry.'),
})
  // Preserve unknown NESTED fields inside `sensitivity` on a successful parse,
  // so a future sub-schema field survives the persistStores writeback (which
  // merges parsed deltas onto the raw entry). Without this the typed parse
  // would strip nested unknowns and the merge could never see them.
  .passthrough()
  .describe('Per-scope sensitivity policy consumed by the write-time leak guard.')

export type ScopeSensitivity = z.infer<typeof ScopeSensitivitySchema>

/**
 * Prompt-injection hardening: a scope's `description` and `covers[]` reach the
 * agent VERBATIM via `plur_scopes_discover`, so a hostile store's
 * `/api/v1/me` could smuggle instructions in. The bounds live in the schema
 * because the remote `/me` path DROPS any `scope_metadata` entry failing
 * `safeParse` (remote-store.ts). Local config is user-authored and unaffected.
 */
const MAX_DESCRIPTION_LEN = 500
const MAX_COVER_LEN = 120
const MAX_COVERS = 32
// Forbid C0 control chars (U+0000–U+001F — includes \n, \r, \t), DEL (U+007F),
// C1 control chars (U+0080–U+009F) and U+2028/U+2029: the newline /
// control-char channel a prompt-injection payload needs to fake a new
// instruction block. All four ECMA-262 LineTerminators (LF, CR, LS, PS) are
// excluded. Ordinary printable text (incl. unicode punctuation and emoji)
// passes untouched.
const NO_CONTROL_CHARS = /^[^\u0000-\u001F\u007F-\u009F\u2028\u2029]*$/
const NO_CONTROL_MSG = 'must not contain control characters or newlines (directive-surface hardening, #345)'

export const ScopeMetadataSchema = z.object({
  scope: z.string()
    .describe('The scope this metadata describes (e.g. "group:plur/engineering", "project:plur").'),
  // null-tolerant: a server serialises an unset nullable column as JSON
  // `null`, and RemoteStore.me() silently drops rows that fail to parse.
  // Coerced to '' so the OUTPUT type stays `string`.
  // `=== null` deliberately, NOT `== null`: an ABSENT description is a
  // malformed row and must still be rejected. Coercing undefined too would
  // quietly turn a required field optional.
  description: z.preprocess(
    v => (v === null ? '' : v),
    z.string().max(MAX_DESCRIPTION_LEN).regex(NO_CONTROL_CHARS, NO_CONTROL_MSG),
  )
    .describe('Human-readable explanation of what this scope is for. Surfaced VERBATIM in scope/store discovery — bounded in length and free of control chars/newlines so a hostile remote cannot inject instructions (#345). An explicit null reads as empty, so a server serialising an unset column does not fail the row; the key itself is still required (#843).'),
  covers: z.array(z.string().max(MAX_COVER_LEN).regex(NO_CONTROL_CHARS, NO_CONTROL_MSG)).max(MAX_COVERS).default([])
    .describe('Topics, domains, or areas this scope is the home for. Advisory; helps an agent pick the right scope and is surfaced in discovery. Each entry is length-bounded and control-char-free, and the list is capped, for the same directive-surface reason as `description` (#345).'),
  // null -> undefined at the trust boundary: Zod's .optional() REJECTS null,
  // and an unset nullable column is exactly what a server sends as null.
  sensitivity: z.preprocess(v => (v === null ? undefined : v), ScopeSensitivitySchema.optional())
    .describe('Per-scope sensitivity policy. When present, the leak guard uses it; when absent, the guard falls back to the default shared-scope behavior.'),
  // null -> undefined at the trust boundary (see `sensitivity`).
  injection_policy: z.preprocess(v => (v === null ? undefined : v), z.enum(['on_match', 'on_request', 'always']).optional())
    .describe("When the loader may inject this scope's engrams. Mirrors pack injection_policy semantics."),
  // null -> undefined at the trust boundary (see `sensitivity`).
  owner: z.preprocess(v => (v === null ? undefined : v), z.string().optional())
    .describe('Owner of the scope (person or team). Advisory.'),
}).describe('Self-describing metadata for an engram scope (Open Engram Standard, scope layer).')

export type ScopeMetadata = z.infer<typeof ScopeMetadataSchema>
