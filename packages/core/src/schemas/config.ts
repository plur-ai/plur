import { z } from 'zod'
import { ScopeSensitivitySchema } from './scope-metadata.js'

/**
 * `.partial()` with the meaning these schemas were written for: an absent key
 * stays absent, even when the field declares a `.default()`.
 *
 * In a `.partial()` object the defaults below only document the runtime
 * fallbacks (which live in the code that reads the config). zod 4 would apply
 * them, filling every unset key on load and writing them all back into
 * config.yaml. Dropping the default under the optional keeps it so: a value
 * that is present is parsed by the same schema, an absent one stays absent.
 */
function partialKeepAbsent<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  const typed = schema.partial()
  const shape: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    const inner = field instanceof z.ZodDefault || field instanceof z.ZodPrefault ? field.unwrap() as z.ZodType : field
    shape[key] = inner.optional()
  }
  return z.object(shape) as unknown as typeof typed
}

/**
 * A store is filesystem (`path` — YAML or SQLite) or remote (`url` + token, a PLUR
 * Enterprise server over HTTP); exactly one of path/url must be present.
 * Optional scope metadata (`description`, `covers`, `sensitivity`) describes the
 * scope locally; absent metadata falls back to the default shared-scope leak guard.
 */
export const StoreEntrySchema = z.object({
  path: z.string().optional(),
  url: z.string().url().optional(),
  token: z.string().optional(),       // Bearer for remote stores; ignored for path
  /**
   * Name of an environment variable holding the Bearer token. The
   * token is read from it when config.yaml is loaded (when `token` is absent)
   * and is never written back to the file — `plur stores add --token-env VAR`
   * and `plur remote --token-env VAR` store only this reference.
   */
  token_env: z.string().optional(),
  scope: z.string(),
  shared: z.boolean().default(false),
  readonly: z.boolean().default(false),
  /**
   * Per-store override for the server-authoritative recall dialing rule.
   * Optional — absent means the strict
   * scope-relevance rule decides:
   *   - `always` — this store's host is dialed on every recall, and this
   *     store's scope is always in the dialed set, project context or not.
   *   - `never`  — this store never participates in live remote recall
   *     (its scope is excluded from dialing; other entries on the same host
   *     still dial normally).
   */
  dial: z.enum(['always', 'never']).optional().catch(undefined),
  description: z.string().optional()
    .describe('Human-readable explanation of what this scope is for. Surfaced in store/scope discovery.'),
  // `covers` and `sensitivity` are shape-tolerant: a malformed SHAPE
  // (e.g. `covers: 5`, `sensitivity: 'oops'`) must NOT fail the whole StoreEntry
  // safeParse — otherwise loadConfig drops the entry incl. its url/token.
  // A non-array `covers` / non-object `sensitivity` coerces to `undefined` (the
  // field is dropped, not the entry). A malformed `sensitivity` OBJECT (e.g.
  // scalar `allow`/`forbid`) is handled field-by-field inside
  // ScopeSensitivitySchema, which never throws.
  covers: z.preprocess((val) => (Array.isArray(val) ? val.filter((x) => typeof x === 'string') : undefined), z.array(z.string()).optional())
    .describe('Topics/domains this scope is the home for. Advisory; surfaced in discovery. A non-array shape coerces to undefined (not fatal) so it never drops the whole store entry.'),
  sensitivity: z.preprocess(
    (val) => (val != null && typeof val === 'object' && !Array.isArray(val) ? val : undefined),
    ScopeSensitivitySchema.optional(),
  )
    .describe("Per-scope sensitivity policy consumed by the write-time leak guard. When present, overrides the default shared-scope demote-everything behavior for this scope. A non-object shape coerces to undefined (not fatal) so it never drops the whole store entry."),
})
  // Preserve unknown/future TOP-LEVEL store fields on a successful parse, so a config written by a NEWER PLUR (extra top-level keys) is not
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

// Shape-tolerance helpers for the server entry: a malformed or
// future-version VALUE drops that field, never the whole entry and its token.
const plainObjectOr = <T>(fallback: T) => (val: unknown) =>
  (val != null && typeof val === 'object' && !Array.isArray(val) ? val : fallback)
const stringList = (val: unknown) => (Array.isArray(val) ? val.filter((s) => typeof s === 'string') : undefined)

// Per-scope metadata stored inside a ServerStoreEntry's `scope_settings` map.
// Same shape-tolerance as StoreEntrySchema's dial/description/covers/sensitivity fields.
export const ScopeSettingsSchema = z.object({
  dial: z.enum(['always', 'never']).optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  covers: z.preprocess(stringList, z.array(z.string()).optional()),
  sensitivity: z.preprocess(plainObjectOr(undefined), ScopeSensitivitySchema.optional()),
}).passthrough()

export type ScopeSettings = z.infer<typeof ScopeSettingsSchema>

// `discovery` — cached answer from the last successful /api/v1/me call.
// Every field is `.catch(undefined)`: a value written by a newer client (a new
// `status`, say) must not make an older client drop the company server.
export const DiscoveryCacheSchema = z.object({
  discovered_at: z.string().optional().catch(undefined),
  scopes_status: z.enum(['ok', 'not_synced']).optional().catch(undefined),
  gitlab_host: z.string().nullable().optional().catch(undefined),
  project_paths: z.record(z.string(), z.string()).optional().catch(undefined),
  username: z.string().optional().catch(undefined),
  org_id: z.string().optional().catch(undefined),
  // absent = unknown; null = no expiry (these are different values — never conflate them)
  key_expires_at: z.string().nullable().optional().catch(undefined),
  status: z.enum(['ok', 'not_synced', 'failed', 'auth_failed', 'degraded']).optional().catch(undefined),
  checked_at: z.string().optional().catch(undefined),
}).passthrough()

export type DiscoveryCache = z.infer<typeof DiscoveryCacheSchema>

// `enterprise` block — company-server-specific metadata on a store entry.
export const EnterpriseBlockSchema = z.object({
  hello_engram_id: z.string().optional().catch(undefined),
}).passthrough()

export type EnterpriseBlock = z.infer<typeof EnterpriseBlockSchema>

/**
 * A multi-scope server store entry: one company PLUR server and all the scopes it
 * grants, expanded at load into one in-memory `StoreEntry` per scope.
 * - Detected by `url` plus an own `scopes` key (`enterprise` is not required).
 * - Shape-tolerant: malformed `scopes`/`pinned_scopes`/`enterprise`/`discovery`/
 *   `scope_settings` values are dropped, never the entry; scopes failing
 *   `/^[\w:./-]+$/` are dropped with a warning at expansion.
 * - `scope` (singular) is kept for older clients, which drop the entry without it.
 */
export const ServerStoreEntrySchema = z.object({
  url: z.string().url(),
  token: z.string().optional(),
  token_env: z.string().optional(),
  readonly: z.boolean().default(false),
  shared: z.boolean().optional(),
  scope: z.string().optional(),
  scopes: z.preprocess((val) => stringList(val) ?? [], z.array(z.string())),
  pinned_scopes: z.preprocess(stringList, z.array(z.string()).optional()),
  enterprise: z.preprocess(plainObjectOr({}), EnterpriseBlockSchema.default({})),
  scope_settings: z.preprocess(
    (val) => {
      const obj = plainObjectOr(undefined)(val) as Record<string, unknown> | undefined
      if (!obj) return undefined
      return Object.fromEntries(Object.entries(obj).filter(([, v]) => plainObjectOr(undefined)(v) !== undefined))
    },
    z.record(z.string(), ScopeSettingsSchema).optional(),
  ),
  discovery: z.preprocess(plainObjectOr(undefined), DiscoveryCacheSchema.optional()),
}).passthrough()

export type ServerStoreEntry = z.infer<typeof ServerStoreEntrySchema>

export const LlmTierConfigSchema = partialKeepAbsent(z.object({
  dedup_tier: z.enum(['fast', 'balanced', 'thorough']).default('fast'),
  profile_tier: z.enum(['fast', 'balanced', 'thorough']).default('balanced'),
  meta_tier: z.enum(['fast', 'balanced', 'thorough']).default('thorough'),
}))

export const ProfileConfigSchema = partialKeepAbsent(z.object({
  enabled: z.boolean().default(true),
  cache_ttl_hours: z.number().default(24),
}))

export const DedupConfigSchema = partialKeepAbsent(z.object({
  enabled: z.boolean().default(true),
  /**
   * Similarity at or above which a near-duplicate is flagged in the write
   * result. REPORTING ONLY — it does not suppress a write. Kept in sync
   * with the runtime default in learn-async.ts, which is the value that
   * actually applies when this key is absent (`.partial()` suppresses the Zod
   * default, so a mismatch here is invisible at runtime and misleads whoever
   * reads the schema to find out what the default is).
   */
  threshold: z.number().min(0).max(1).default(0.85),
  mode: z.enum(['llm', 'cosine', 'off']).default('llm'),
}))


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
export const EmbeddingsConfigSchema = partialKeepAbsent(z.object({
  enabled: z.boolean().default(true),
}))


/**
 * Vector-column configuration for the PGLite/pgvector index.
 * `precision`: `float32` (`vector(N)`, 4 B/dim) or `halfvec` (`halfvec(N)`, 2 B/dim,
 * slightly lower recall, pgvector >= 0.7; in PGLite exact scans cost ~3-10x more CPU —
 * choose it for storage, not speed).
 * UNSET keeps whatever the store already uses, so omitting it never migrates. Setting it
 * migrates lazily on next init via an in-place `ALTER TABLE ... USING` cast;
 * `plur sync --full` rebuilds from YAML (ADR-0001). int8/binary are not offered.
 */
export const VectorConfigSchema = partialKeepAbsent(z.object({
  precision: z.enum(['float32', 'halfvec']),
}))


/**
 * Server-Postgres backend configuration (ADR-0005). Without `url` the `postgres`
 * tier is unreachable and selection caps at PGLite. `PLUR_POSTGRES_URL` overrides `url`.
 * `vector_index`: `auto` (default; exact below the row threshold, HNSW above), `exact`, `hnsw`.
 * `ef_search` is a FLOOR: each query raises it to at least the limit, since
 * pgvector's default (40) silently truncates results.
 */
export const PostgresConfigSchema = partialKeepAbsent(z.object({
  url: z.string().optional()
    .describe('libpq connection string. Prefer PLUR_POSTGRES_URL so credentials stay out of config.yaml.'),
  schema: z.string().optional().describe('Schema owning the PLUR tables (default: plur).'),
  vector_index: z.enum(['auto', 'exact', 'hnsw']).optional(),
  hnsw_m: z.number().int().positive().optional().catch(undefined),
  hnsw_ef_construction: z.number().int().positive().optional().catch(undefined),
  ef_search: z.number().int().positive().optional().catch(undefined),
  max_connections: z.number().int().positive().optional().catch(undefined),
}))


/**
 * Scope-routing tuning — optional overrides for the ranker that auto-routes
 * unscoped writes; defaults match the constants in scope-routing.ts.
 * WEIGHT_DOMAIN (1.5) is NOT configurable: a lone domain match clearing the threshold
 * is load-bearing.
 */
// Each field uses `.catch(undefined)` so one out-of-range value drops only that
// field instead of failing the whole config parse (which would drop every store
// and reset routing to defaults).
export const ScopeRoutingConfigSchema = partialKeepAbsent(z.object({
  /** Minimum confidence to auto-route an unscoped write. Default: 0.5. */
  match_threshold: z.number().min(0).max(1).optional().catch(undefined),
  /** Per-tag weight in the ranker. Default: 0.5. */
  weight_tag: z.number().min(0).optional().catch(undefined),
  /**
   * Floor for the SUGGESTION surface: `suggestScope` drops candidates
   * below this confidence, clipping lone-coincidental-keyword noise (≈0.12).
   * Independent of `match_threshold` (the auto-route gate). Default: 0 — no
   * floor at the core API; the MCP `plur_suggest_scope` tool falls back to
   * SUGGEST_DISPLAY_MIN_CONFIDENCE (0.15) when neither the tool arg nor this
   * key is set.
   */
  min_confidence: z.number().min(0).max(1).optional().catch(undefined),
  /**
   * Opt in to auto-routing a genuinely-unscoped write into a SHARED scope. Default
   * FALSE: such a write can be pushed to a team remote, which local cleanup cannot
   * undo. Routing among personal scopes is unaffected. If enabled, also raise
   * `match_threshold` — a lone forward domain-prefix match bypasses the threshold.
   */
  allow_shared_auto_route: z.boolean().optional().catch(undefined),
}))

export type ScopeRoutingConfig = z.infer<typeof ScopeRoutingConfigSchema>

/**
 * Tension-scan configuration — temporal-aware contradiction detection.
 * - `temporal_domains`: domains whose engrams are point-in-time snapshots; a
 *   snapshot pair from different days is skipped (`snapshot_pairs: 'skip'`) or
 *   capped at confidence 0.1 (`'floor'`). Retroactive, no re-tagging.
 * - `temporal_discount`: multiplies judge confidence by a days-apart ladder.
 *   OFF by default — it can bury genuine corrections made weeks apart.
 */
export const TensionsConfigSchema = partialKeepAbsent(z.object({
  temporal_domains: z.array(z.string()).default([]),
  snapshot_pairs: z.enum(['skip', 'floor']).default('skip'),
  /**
   * Same-origin measurement pairs whose `measured_under` configuration
   * differs: 'skip' (default) drops them before the judge and counts
   * them in the scan result; 'floor' judges them with confidence capped.
   * Never applies across stores or packs.
   */
  measured_under_pairs: z.enum(['skip', 'floor']).default('skip'),
  temporal_discount: z.boolean().default(false),
}))


export const PlurConfigSchema = partialKeepAbsent(z.object({
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
    /**
     * Share of `injection_budget` reserved for pinned engrams — the QUOTA
     * enforced when pinning rather than a cap applied silently at injection
     * time. Must be declared here: the object strips unknown keys.
     */
    pinned_ratio: z.number().min(0).max(1).default(0.5),
    /**
     * Share of the pinned quota the HARD pinned tier may occupy (pinned
     * two-tier model). The hard tier is a sub-cap inside the pinned quota, so
     * it is bounded to [0, 1] and can never exceed it; soft pins get what the
     * hard tier leaves. Default 0.5 — at the default `injection_budget` of
     * 2000 and `pinned_ratio` of 0.5, a 500-token hard tier.
     */
    pinned_hard_ratio: z.number().min(0).max(1).default(0.5),
  }).prefault({}),
  dedup: DedupConfigSchema.prefault({}),
  /**
   * When to write a provenance record. Default `never`: records duplicate the
   * history log, and the trust boundary is when an engram leaves the store.
   * `on_export` is recommended for anyone sharing engrams.
   */
  provenance: z.object({
    generate: z.enum(['never', 'on_export', 'always']).default('never'),
    /** Where records are written, relative to the PLUR home directory. */
    path: z.string().default('provenance'),
    /** Include the engram's own text in a shared record. Off by default. */
    include_statement: z.boolean().default(false),
    /**
     * Licence offered first and used when the user does not pick. A licence set here
     * was chosen, unlike the schema default, which `engram:licenseSource` records.
     * Unset by default on purpose.
     */
    default_license: z.string().optional(),
    /**
     * Who this machine's memories are attributed to; any address form (local name,
     * DID, email, process id). Unset records the `unidentified` marker.
     * NEVER default it from the OS account (that names people without consent).
     * Self-asserted: nothing verifies it, and no surface may present it as verified.
     */
    identity: z.string().optional(),
  }).prefault({}),
  /** Temporal-aware tension scan tuning. See {@link TensionsConfigSchema}. */
  tensions: TensionsConfigSchema.prefault({}),
  /**
   * Cross-scope recurrence ladder policy.
   *
   * `max_commitment` caps how high the ladder may escalate an engram's
   * commitment when the same statement recurs across scopes — team validation
   * (a team save crediting a matching engram) and the global copy made by
   * copy-on-promote included. `locked` (default) lets the ladder reach
   * `locked`; `decided` stops it one step below, so only an explicit human act
   * locks an engram. A config without this key behaves as `locked`. An
   * unresolved tension still blocks the step into `locked` either way.
   */
  recurrence: z.object({
    max_commitment: z.enum(['locked', 'decided']).default('locked'),
  }).prefault({}),
  /**
   * Expiry handling at injection time. `hard` (default) skips any
   * engram whose `temporal.valid_until` is in the past. `soft` keeps
   * injecting a recently-expired engram for `grace_days` days after expiry,
   * rendered with a loud "⚠ EXPIRED <date> — verify before use" marker —
   * some facts stay useful as history. Recall filtering is unaffected
   * (always hard).
   */
  expiry: z.object({
    mode: z.enum(['hard', 'soft']).default('hard'),
    grace_days: z.number().default(30),
  }).prefault({}),
  decay_baseline: z.string().optional(),
  allow_secrets: z.boolean().default(false),
  index: z.boolean().default(true),
  /**
   * Storage tier OVERRIDE. Unset, the tier is chosen by store size (ADR-0005,
   * `backend-selection.ts`); set, it is respected.
   *   - `yaml`     — no index; in-memory BM25 + exact cosine (`index: true` adds sqlite)
   *   - `sqlite`   — legacy better-sqlite3 index (requires `index: true`)
   *   - `pglite`   — PGLite WASM + pgvector + Apache AGE (ADR-0001)
   *   - `postgres` — server Postgres as store AND index (ADR-0005)
   * Env override: PLUR_BACKEND=yaml|sqlite|pglite|postgres.
   */
  backend: z.enum(['yaml', 'sqlite', 'pglite', 'postgres']).optional(),
  embeddings: EmbeddingsConfigSchema.prefault({}),
  vector: VectorConfigSchema.prefault({}),
  /** Server-Postgres backend settings (ADR-0005). See {@link PostgresConfigSchema}. */
  postgres: PostgresConfigSchema.prefault({}),
  stores: z.array(StoreEntrySchema).default([]),
  /**
   * Shared scopes the user has explicitly dismissed from the "authorized but
   * unregistered" offer. Excluded from discoverRemoteScopes().unregistered
   * and from the session-start hint so they stop being re-surfaced every session.
   * `plur scopes --reoffer` clears this list.
   */
  dismissed_scopes: z.array(z.string()).default([]),
  llm: LlmTierConfigSchema.prefault({}),
  profile: ProfileConfigSchema.prefault({}),
  registry_url: z.string().url().optional(),
  /**
   * Where a genuinely-unscoped write lands. `local` and `global` are both personal,
   * so this is an organizational default, NOT a leak-safety control (the sensitivity
   * guard still runs after it). Personal-family scopes are visible under scoped
   * recall/inject, so `local` keeps writes machine-local without hiding them.
   */
  unscoped_default: z.enum(['local', 'global']).default('global'),
  /**
   * When true (default), a genuinely-unscoped write (no explicit scope, no
   * session/`.plur.yaml` default) is run through the deterministic
   * {@link suggestScope} ranker; if the top candidate clears
   * SCOPE_MATCH_THRESHOLD the engram is auto-routed to that scope, otherwise it
   * falls to `unscoped_default`. INERT until scopes declare `covers`:
   * with no `covers` the ranker returns nothing and everything falls to
   * `unscoped_default`. Set false to disable auto-routing entirely.
   */
  auto_route_scope: z.boolean().default(true),
  /**
   * Scope-routing tuning — optional overrides for the deterministic ranker.
   * See {@link ScopeRoutingConfigSchema} for per-field semantics.
   */
  scope_routing: ScopeRoutingConfigSchema.prefault({}),
  /**
   * Git-sync remote semantics. `personal` (default) mirrors every
   * non-`scope:local` engram to the remote — private included — which is
   * correct for a solo user syncing their own machines. `shared` pushes ONLY
   * engrams with a shared-family scope (`isSharedScope`) AND a non-private
   * visibility: personal-family (`local`/`global`/`user:*`/`agent:*`) and
   * private-visibility engrams never reach a shared/team remote, by
   * construction. Config lives in config.yaml (machine-local, never synced).
   */
  sync: partialKeepAbsent(z.object({
    remote_type: z.enum(['personal', 'shared']).optional(),
  })).prefault({}),
  /**
   * Anchoring session manifests in write-once storage. `off` (the
   * default) makes no network call of any kind. `swarm` uploads a session's
   * manifest — fingerprints only, never engram text, scope names, tags or
   * domains — through the provenance gateway's free tier. Core never uploads;
   * the CLI and MCP surfaces do, when this says so. Set `off` where an outside
   * tool already anchors the manifest, so
   * nothing is uploaded twice.
   */
  receipts: partialKeepAbsent(z.object({
    store: z.enum(['off', 'swarm']).catch('off'),
    gateway_url: z.string().url().optional().catch(undefined),
    /** A postage stamp (batch id) bought through the gateway's stamp endpoints; used instead of a free pool stamp. */
    stamp_id: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().catch(undefined),
  })).optional(),
}))

export type PlurConfig = z.infer<typeof PlurConfigSchema>
