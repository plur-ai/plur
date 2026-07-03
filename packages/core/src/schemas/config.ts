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

/**
 * Vector-column configuration for the PGLite/pgvector index (#223).
 *
 * `precision` selects the pgvector storage type for the embedding column:
 *   - `float32` — pgvector `vector(N)`, 4 bytes/dim (the historical layout)
 *   - `halfvec` — pgvector `halfvec(N)`, 2 bytes/dim (~50% smaller,
 *     -0.2 to -0.5pp recall). Requires pgvector >= 0.7; PGLite 0.4.x bundles
 *     0.8.1, verified working in the WASM build. Note: in PGLite (WASM, no
 *     F16C) halfvec exact scans cost ~3-10x more CPU than float32 — pick it
 *     for storage-constrained stores, not for speed.
 *
 * When UNSET, the adapter keeps whatever the existing store already uses
 * (float32 for new stores) — omitting the knob never migrates a store.
 * Setting it migrates lazily on next init via an atomic in-place
 * `ALTER TABLE ... USING embedding::<type>(N)` cast (no re-embed needed);
 * `plur sync --full` drops and rebuilds the derived index from YAML at the
 * configured precision per ADR-0001's rebuildability invariant.
 *
 * int8 scalar and binary quantization are deferred: pgvector has no int8
 * vector column type (its types are vector/halfvec/sparsevec/bit), and
 * binary-quantized retrieval only makes sense paired with the #220
 * cross-encoder rerank pass.
 */
export const VectorConfigSchema = z.object({
  precision: z.enum(['float32', 'halfvec']),
}).partial()

export type VectorConfigYaml = z.infer<typeof VectorConfigSchema>

/**
 * Scope-routing tuning — optional overrides for the deterministic ranker that
 * auto-routes unscoped writes to a `covers`-matching scope (Stage 3b, #351/#362).
 * Defaults match the module-level constants in scope-routing.ts.
 *
 * Enterprise installs with many narrow, covers-rich scopes may need to raise
 * `match_threshold` to cut false-positive routing. Raising `weight_tag` boosts
 * tag-only signals relative to keyword evidence. WEIGHT_DOMAIN (1.5) is NOT
 * configurable: the lone-domain-clears-threshold invariant is load-bearing.
 */
export const ScopeRoutingConfigSchema = z.object({
  /** Minimum confidence to auto-route an unscoped write. Default: 0.5. */
  match_threshold: z.number().min(0).max(1).optional(),
  /** Per-tag weight in the ranker. Default: 0.5. */
  weight_tag: z.number().min(0).optional(),
}).partial()

export type ScopeRoutingConfig = z.infer<typeof ScopeRoutingConfigSchema>

/**
 * Tension-scan configuration (#240) — temporal-aware contradiction detection.
 *
 * `temporal_domains` (Layer 2) declares domains whose engrams are
 * point-in-time snapshots by default (e.g. war-analysis, markets). A
 * snapshot-vs-snapshot pair recorded on different days is an event log, not
 * a contradiction — the scanner skips it (`snapshot_pairs: 'skip'`, default)
 * or judges it with confidence capped at 0.1 (`'floor'`). Retroactive: no
 * engram re-tagging needed.
 *
 * `temporal_discount` (Layer 3 multiplier) additionally multiplies judge
 * confidence by a days-apart ladder (same day ×1.0 … 15+ days ×0.3).
 * OFF by default: the dated judge prompt is the default mechanism, and a
 * blanket multiplier can bury genuine corrections made weeks apart.
 */
export const TensionsConfigSchema = z.object({
  temporal_domains: z.array(z.string()).default([]),
  snapshot_pairs: z.enum(['skip', 'floor']).default('skip'),
  temporal_discount: z.boolean().default(false),
}).partial()

export type TensionsConfigYaml = z.infer<typeof TensionsConfigSchema>

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
  /** Temporal-aware tension scan tuning (#240). See {@link TensionsConfigSchema}. */
  tensions: TensionsConfigSchema.default({}),
  /**
   * Expiry handling at injection time (#347). `hard` (default) skips any
   * engram whose `temporal.valid_until` is in the past. `soft` keeps
   * injecting a recently-expired engram for `grace_days` days after expiry,
   * rendered with a loud "⚠ EXPIRED <date> — verify before use" marker —
   * some facts stay useful as history. Recall filtering is unaffected
   * (always hard).
   */
  expiry: z.object({
    mode: z.enum(['hard', 'soft']).default('hard'),
    grace_days: z.number().default(30),
  }).default({}),
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
  vector: VectorConfigSchema.default({}),
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
  /**
   * Scope-routing tuning — optional overrides for the deterministic ranker (#362).
   * See {@link ScopeRoutingConfigSchema} for per-field semantics.
   */
  scope_routing: ScopeRoutingConfigSchema.default({}),
}).partial()

export type PlurConfig = z.infer<typeof PlurConfigSchema>
