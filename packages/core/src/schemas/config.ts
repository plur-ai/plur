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
  covers: z.array(z.string()).optional()
    .describe('Topics/domains this scope is the home for (#345). Advisory; surfaced in discovery.'),
  sensitivity: ScopeSensitivitySchema.optional()
    .describe("Per-scope sensitivity policy (#345) consumed by the write-time leak guard. When present, overrides the default shared-scope demote-everything behavior for this scope."),
}).refine(
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
}).partial()

export type PlurConfig = z.infer<typeof PlurConfigSchema>
