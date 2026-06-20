import { z } from 'zod'
import { logger } from '../logger.js'

/**
 * Self-describing scope metadata (#345, Stage 2). A scope can declare what it is
 * for, what it covers, and — crucially — its own sensitivity policy, so the
 * write-time leak guard can make a per-scope decision instead of the blanket
 * "any shared scope rejects all sensitive content" rule from Stage 1.
 *
 * Metadata is OPTIONAL everywhere. A scope with no metadata falls back to the
 * Stage 1 behavior exactly (isSharedScope + detectSensitive → demote). The
 * `sensitivity` default (`forbid: ['secrets','infra']`) reproduces that behavior
 * for a shared scope that declares metadata but no explicit policy, so adding
 * metadata is non-breaking.
 *
 * In Stage 2 this metadata is carried locally on a config `stores` entry
 * (packages/core/src/schemas/config.ts). The enterprise `scopes` table /
 * `/api/v1/scopes` API / admin UI that would serve it centrally are a separate
 * track and intentionally NOT built here.
 */

/** Categories of sensitive content a scope can forbid or explicitly allow.
 *  These map 1:1 to the detector families in secrets.ts:
 *    - 'secrets' → detectSecrets() families (api keys, tokens, passwords, …)
 *    - 'infra'   → infra topology (public IPv4/IPv6, basic-auth URLs,
 *                   host:port, internal/infra hostnames)
 *
 *  PII detection is deliberately OUT OF SCOPE: no detector maps to a 'pii'
 *  category, so a scope declaring `forbid: ['pii']` would silently protect
 *  nothing (false protection). The category is therefore omitted entirely
 *  rather than shipped as a no-op. It can be reintroduced — added back here AND
 *  to sensitivityCategory()'s return type in secrets.ts — once a real,
 *  low-false-positive PII detector exists. */
export const SENSITIVITY_CATEGORIES = ['secrets', 'infra'] as const
export type SensitivityCategory = (typeof SENSITIVITY_CATEGORIES)[number]

export const ScopeSensitivitySchema = z.object({
  /**
   * Sensitive categories that must NOT be written to this scope (PR-3, #353
   * HIGH-17/18). A bare `z.enum(...)` array used to be FATAL on an unknown
   * category: a single hand-edited / forward-compat `forbid: ['pii']` failed the
   * whole StoreEntry safeParse, so loadConfig dropped the entry — including its
   * `url`/`token`. We now preprocess element-wise: unknown categories are
   * dropped (named in a warning), valid ones survive, and only an empty result
   * falls to the safe default. The whole StoreEntry NO LONGER fails on a bad
   * category, so url/token always survive a malformed `sensitivity`.
   *   `['secrets','pii']` → `['secrets']` (warn: pii)
   *   `['pii']`           → `['secrets','infra']` (warn: pii)
   *   scalar `'secrets'`  → `['secrets','infra']` (non-array → safe default, no Zod throw)
   * The preprocess can't name the scope (it runs inside the field schema), so
   * loadConfig adds a post-parse pass that diffs raw vs parsed `forbid` per entry
   * and logs `scope=<s>` for the naming.
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
  allow: z.array(z.string()).default([])
    .describe('Detector pattern names or category names explicitly permitted on this scope, overriding `forbid`. A match whose categories are ALL allowed is not demoted (e.g. a scope that legitimately holds infra topology can allow "infra").'),
})
  // PR-3 (#353): preserve unknown NESTED fields inside `sensitivity` on a
  // successful parse, so a future sub-schema field survives the persistStores
  // writeback (which merges parsed deltas onto the raw entry). Without this the
  // typed parse would strip nested unknowns and the merge could never see them.
  .passthrough()
  .describe('Per-scope sensitivity policy consumed by the write-time leak guard.')

export type ScopeSensitivity = z.infer<typeof ScopeSensitivitySchema>

export const ScopeMetadataSchema = z.object({
  scope: z.string()
    .describe('The scope this metadata describes (e.g. "group:plur/engineering", "project:plur").'),
  description: z.string()
    .describe('Human-readable explanation of what this scope is for. Surfaced in scope/store discovery.'),
  covers: z.array(z.string()).default([])
    .describe('Topics, domains, or areas this scope is the home for. Advisory; helps an agent pick the right scope and is surfaced in discovery.'),
  sensitivity: ScopeSensitivitySchema.optional()
    .describe('Per-scope sensitivity policy. When present, the leak guard uses it; when absent, the guard falls back to the default shared-scope behavior.'),
  injection_policy: z.enum(['on_match', 'on_request', 'always']).optional()
    .describe("When the loader may inject this scope's engrams. Mirrors pack injection_policy semantics."),
  owner: z.string().optional()
    .describe('Owner of the scope (person or team). Advisory.'),
}).describe('Self-describing metadata for an engram scope (Open Engram Standard, scope layer).')

export type ScopeMetadata = z.infer<typeof ScopeMetadataSchema>
