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
  /**
   * Per-store override for the server-authoritative recall dialing rule
   * (#776). Optional and backward compatible — absent means the strict
   * scope-relevance rule decides:
   *   - `always` — this store's host is dialed on every recall, and this
   *     store's scope is always in the dialed set, project context or not.
   *   - `never`  — this store never participates in live remote recall
   *     (its scope is excluded from dialing; other entries on the same host
   *     still dial normally).
   */
  dial: z.enum(['always', 'never']).optional().catch(undefined),
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
  /**
   * Similarity at or above which a near-duplicate is flagged in the write
   * result. REPORTING ONLY — it does not suppress a write (#856). Kept in sync
   * with the runtime default in learn-async.ts, which is the value that
   * actually applies when this key is absent (`.partial()` suppresses the Zod
   * default, so a mismatch here is invisible at runtime and misleads whoever
   * reads the schema to find out what the default is).
   */
  threshold: z.number().min(0).max(1).default(0.85),
  mode: z.enum(['llm', 'cosine', 'off']).default('llm'),
}).partial()


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


/**
 * Server-Postgres backend configuration (ADR-0005).
 *
 * Presence of `url` is what makes the `postgres` tier reachable at all: the
 * size-based selector may decide a corpus wants a server, but without somewhere
 * to connect it caps at PGLite and says so. `PLUR_POSTGRES_URL` overrides `url`.
 *
 * `vector_index` picks the recall/latency trade-off explicitly:
 *   - `auto` (default) — exact below the row threshold, HNSW above it
 *   - `exact`          — never approximate; 100% recall, linear scan
 *   - `hnsw`           — always approximate
 *
 * `ef_search` is a FLOOR, not a fixed value: every query raises it to at least
 * the requested limit, because pgvector's default (40) sits below most useful
 * limits and silently truncates the result set.
 */
export const PostgresConfigSchema = z.object({
  url: z.string().optional()
    .describe('libpq connection string. Prefer PLUR_POSTGRES_URL so credentials stay out of config.yaml.'),
  schema: z.string().optional().describe('Schema owning the PLUR tables (default: plur).'),
  vector_index: z.enum(['auto', 'exact', 'hnsw']).optional(),
  hnsw_m: z.number().int().positive().optional().catch(undefined),
  hnsw_ef_construction: z.number().int().positive().optional().catch(undefined),
  ef_search: z.number().int().positive().optional().catch(undefined),
  max_connections: z.number().int().positive().optional().catch(undefined),
}).partial()


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
// Field-level tolerance (#670 review): these fields sit inside the top-level
// PlurConfigSchema.parse(), where a single out-of-range value (e.g.
// `min_confidence: 1.5`, or `15` from a percent misread) would otherwise fail
// the WHOLE config parse — loadConfig's catch falls back to full defaults,
// silently dropping every configured store AND reverting match_threshold to
// 0.5 for the process (so unscoped writes start auto-routing at the default
// gate). `.catch(undefined)` drops only the bad field instead, mirroring the
// per-entry tolerance philosophy the stores array already follows.
export const ScopeRoutingConfigSchema = z.object({
  /** Minimum confidence to auto-route an unscoped write. Default: 0.5. */
  match_threshold: z.number().min(0).max(1).optional().catch(undefined),
  /** Per-tag weight in the ranker. Default: 0.5. */
  weight_tag: z.number().min(0).optional().catch(undefined),
  /**
   * Floor for the SUGGESTION surface (#670): `suggestScope` drops candidates
   * below this confidence, clipping lone-coincidental-keyword noise (≈0.12).
   * Independent of `match_threshold` (the auto-route gate). Default: 0 — no
   * floor at the core API; the MCP `plur_suggest_scope` tool falls back to
   * SUGGEST_DISPLAY_MIN_CONFIDENCE (0.15) when neither the tool arg nor this
   * key is set.
   */
  min_confidence: z.number().min(0).max(1).optional().catch(undefined),
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
  /**
   * Same-origin measurement pairs whose `measured_under` configuration
   * differs (#869): 'skip' (default) drops them before the judge and counts
   * them in the scan result; 'floor' judges them with confidence capped.
   * Never applies across stores or packs.
   */
  measured_under_pairs: z.enum(['skip', 'floor']).default('skip'),
  temporal_discount: z.boolean().default(false),
}).partial()


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
   * Storage tier selector — an OVERRIDE, not a default.
   *
   * Leave it unset and the tier is chosen from the size of the store (ADR-0005,
   * `backend-selection.ts`): `yaml` for a personal corpus, `pglite` past ~5k
   * engrams, `postgres` past ~50k when `postgres.url` is configured. Set it and
   * that choice is yours — the automatic path exists to make the default sane,
   * not to overrule a decision someone made on purpose.
   *
   *   - `yaml`     — no index; in-memory BM25 + exact cosine (with `index: true`,
   *                  the legacy better-sqlite3 metadata index)
   *   - `sqlite`   — legacy better-sqlite3 index (requires `index: true`)
   *   - `pglite`   — ADR-0001 substrate: PGLite WASM + pgvector + Apache AGE
   *   - `postgres` — ADR-0005: server Postgres as store AND index
   *
   * Env override: PLUR_BACKEND=yaml|sqlite|pglite|postgres.
   */
  backend: z.enum(['yaml', 'sqlite', 'pglite', 'postgres']).optional(),
  embeddings: EmbeddingsConfigSchema.default({}),
  vector: VectorConfigSchema.default({}),
  /** Server-Postgres backend settings (ADR-0005). See {@link PostgresConfigSchema}. */
  postgres: PostgresConfigSchema.default({}),
  stores: z.array(StoreEntrySchema).default([]),
  /**
   * Shared scopes the user has explicitly dismissed from the "authorized but
   * unregistered" offer (#647). Excluded from discoverRemoteScopes().unregistered
   * and from the session-start hint so they stop being re-surfaced every session.
   * `plur scopes --reoffer` clears this list.
   */
  dismissed_scopes: z.array(z.string()).default([]),
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
  /**
   * Git-sync remote semantics (#640). `personal` (default) mirrors every
   * non-`scope:local` engram to the remote — private included — which is
   * correct for a solo user syncing their own machines. `shared` pushes ONLY
   * engrams with a shared-family scope (`isSharedScope`) AND a non-private
   * visibility: personal-family (`local`/`global`/`user:*`/`agent:*`) and
   * private-visibility engrams never reach a shared/team remote, by
   * construction. Config lives in config.yaml (machine-local, never synced).
   */
  sync: z.object({
    remote_type: z.enum(['personal', 'shared']).optional(),
  }).partial().default({}),
}).partial()

export type PlurConfig = z.infer<typeof PlurConfigSchema>
