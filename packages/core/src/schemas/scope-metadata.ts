import { z } from 'zod'

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
  forbid: z.array(z.enum(SENSITIVITY_CATEGORIES)).default(['secrets', 'infra'])
    .describe('Sensitive categories that must NOT be written to this scope. A write that trips one of these is demoted to local/private. Default reproduces Stage 1: secrets + infra are forbidden on shared scopes.'),
  allow: z.array(z.string()).default([])
    .describe('Detector pattern names or category names explicitly permitted on this scope, overriding `forbid`. A match whose categories are ALL allowed is not demoted (e.g. a scope that legitimately holds infra topology can allow "infra").'),
}).describe('Per-scope sensitivity policy consumed by the write-time leak guard.')

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
