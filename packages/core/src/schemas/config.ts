import { z } from 'zod'
import { ScopeSensitivitySchema } from './scope-metadata.js'

/**
 * A store can be either:
 *   - filesystem (path) — historical default; YAML or SQLite
 *   - remote (url + token) — speaks to a PLUR Enterprise server over HTTP
 * Exactly one of path/url must be present.
 *
 * A store entry may also carry self-describing scope metadata (#345) —
 * `description`, `covers`, `sensitivity` — so a registered scope declares
 * locally what it is for and its sensitivity policy. All metadata fields are
 * optional and non-breaking; absent metadata falls back to the default
 * shared-scope leak-guard behavior.
 */
export const StoreEntrySchema = z.object({
  path: z.string().optional(),
  url: z.string().url().optional(),
  token: z.string().optional(),       // Bearer for remote stores; ignored for path
  scope: z.string(),
  shared: z.boolean().default(false),
  readonly: z.boolean().default(false),
  description: z.string().optional()
    .describe('Human-readable explanation of what this scope is for (#345). Surfaced in store/scope discovery.'),
  // `covers` and `sensitivity` are shape-tolerant (R2-D #7): a malformed SHAPE
  // (e.g. `covers: 5`, `sensitivity: 'oops'`) must NOT fail the whole StoreEntry
  // safeParse — otherwise loadConfig drops the entry incl. its url/token,
  // reproducing the exact credential-loss bug PR-3 set out to close (PR-3 only
  // rescued an unknown `forbid` CATEGORY, not a malformed enclosing shape).
  // A non-array `covers` / non-object `sensitivity` coerces to `undefined` (the
  // field is dropped, not the entry). A malformed `sensitivity` OBJECT (e.g.
  // scalar `allow`/`forbid`) is handled field-by-field inside
  // ScopeSensitivitySchema, which never throws.
  covers: z.preprocess((val) => (Array.isArray(val) ? val.filter((x) => typeof x === 'string') : undefined), z.array(z.string()).optional())
    .describe('Topics/domains this scope is the home for (#345). Advisory; surfaced in discovery. A non-array shape coerces to undefined (not fatal) so it never drops the whole store entry.'),
  sensitivity: z.preprocess(
    (val) => (val != null && typeof val === 'object' && !Array.isArray(val) ? val : undefined),
    ScopeSensitivitySchema.optional(),
  )
    .describe("Per-scope sensitivity policy (#345) consumed by the write-time leak guard. When present, overrides the default shared-scope demote-everything behavior for this scope. A non-object shape coerces to undefined (not fatal) so it never drops the whole store entry."),
})
  // PR-3 (#353): preserve unknown/future TOP-LEVEL store fields on a successful
  // parse, so a config written by a NEWER PLUR (extra top-level keys) is not
  // silently stripped when an OLDER PLUR re-parses and writes it back. The
  // `.passthrough()` is placed BEFORE `.refine()` (refine yields a ZodEffects
  // with no `.passthrough`); the path-xor-url predicate only touches known
  // fields, so passthrough does not relax it.
  .passthrough()
  .refine(
    (s) => Boolean(s.path) !== Boolean(s.url),
    { message: 'StoreEntry requires exactly one of path or url' },
  )

export type StoreEntry = z.infer<typeof StoreEntrySchema>

export const LlmTierConfigSchema = z.object({
  dedup_tier: z.enum(['fast', 'balanced', 'thorough']).default('fast'),
  profile_tier: z.enum(['fast', 'balanced', 'thorough']).default('balanced'),
  meta_tier: z.enum(['fast', 'balanced', 'thorough']).default('thorough'),
}).partial()

export const ProfileConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cache_ttl_hours: z.number().default(24),
}).partial()

export const DedupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().min(0).max(1).default(0.85),
  mode: z.enum(['llm', 'cosine', 'off']).default('llm'),
}).partial()

export type DedupConfigYaml = z.infer<typeof DedupConfigSchema>

export const StorageConfigSchema = z.object({
  backend: z.enum(['yaml', 'sqlite']).default('yaml'),
  path: z.string().optional(),
}).partial()

export type StorageConfigYaml = z.infer<typeof StorageConfigSchema>

/**
 * Embedding-layer configuration. When enabled is false, the BGE model is not
 * loaded and recall_hybrid runs in BM25-only mode. The PLUR_DISABLE_EMBEDDINGS
 * env var also disables embeddings (env precedence at import time).
 *
 * Hardware footprint of enabled embeddings: ~130MB BGE model on first use,
 * a few hundred MB RAM while the model is resident, ONNX runtime native
 * binary. Disable for low-resource environments or strict-offline setups
 * where the first-run model download is unwanted.
 */
export const EmbeddingsConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).partial()

export type EmbeddingsConfigYaml = z.infer<typeof EmbeddingsConfigSchema>

export const PlurConfigSchema = z.object({
  auto_learn: z.boolean().default(true),
  auto_capture: z.boolean().default(true),
  injection_budget: z.number().default(2000),
  decay_enabled: z.boolean().default(true),
  decay_threshold: z.number().default(0.15),
  packs: z.array(z.string()).default([]),
  injection: z.object({
    spread_cap: z.number().default(3),
    spread_budget: z.number().default(480),
    co_access: z.boolean().default(true),
  }).default({}),
  dedup: DedupConfigSchema.default({}),
  decay_baseline: z.string().optional(),
  allow_secrets: z.boolean().default(false),
  index: z.boolean().default(true),
  /**
   * Index backend selector. `sqlite` is the historical default
   * (better-sqlite3, in-process WAL). `pglite` opts in to the ADR-0001
   * substrate — PGLite WASM + pgvector + Apache AGE. PGLite is opt-in until
   * the bake-off completes; defaults remain sqlite to keep the existing
   * test surface stable.
   * Env override: PLUR_BACKEND=pglite|sqlite.
   */
  backend: z.enum(['sqlite', 'pglite']).default('sqlite'),
  storage: StorageConfigSchema.default({}),
  embeddings: EmbeddingsConfigSchema.default({}),
  stores: z.array(StoreEntrySchema).default([]),
  llm: LlmTierConfigSchema.default({}),
  profile: ProfileConfigSchema.default({}),
  registry_url: z.string().url().optional(),
  /**
   * Where a genuinely-unscoped write lands when nothing else decides its scope
   * (Stage 3b, #351; reverted to `global` in 0.10.0, #353). Both `local` and
   * `global` are PERSONAL, non-shared scopes — the enterprise "global" was
   * renamed to `org` on 2026-05-11 — so this is an organizational default, NOT a
   * leak-safety control (the sensitivity guard runs after this and still demotes
   * an auto-routed SHARED scope carrying sensitive content).
   *
   * Defaults to `global` (the historical pre-3b default): the cross-project
   * personal namespace, read-visible under any scoped recall/inject. With the
   * 0.10.0 read-side fix, personal-family scopes — `local`, `global`, `user:*`,
   * `agent:*` — are ALL visible under a project-scope recall/inject, so setting
   * this to `local` keeps unscoped writes machine-local WITHOUT making them
   * invisible to scoped sessions. `local` is a fully supported option, not a
   * silent regression.
   */
  unscoped_default: z.enum(['local', 'global']).default('global'),
  /**
   * When true (default), a genuinely-unscoped write (no explicit scope, no
   * session/`.plur.yaml` default) is run through the deterministic
   * {@link suggestScope} ranker; if the top candidate clears
   * SCOPE_MATCH_THRESHOLD the engram is auto-routed to that scope, otherwise it
   * falls to `unscoped_default`. INERT until scopes declare `covers` (Stage 5):
   * with no `covers` the ranker returns nothing and everything falls to
   * `unscoped_default`. Set false to disable auto-routing entirely.
   */
  auto_route_scope: z.boolean().default(true),
}).partial()

export type PlurConfig = z.infer<typeof PlurConfigSchema>
