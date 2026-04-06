import { z } from 'zod'

export const StoreEntrySchema = z.object({
  path: z.string(),
  scope: z.string(),
  shared: z.boolean().default(false),
  readonly: z.boolean().default(false),
})

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
  storage: StorageConfigSchema.default({}),
  stores: z.array(StoreEntrySchema).default([]),
  llm: LlmTierConfigSchema.default({}),
  profile: ProfileConfigSchema.default({}),
  registry_url: z.string().url().optional(),
}).partial()

export type PlurConfig = z.infer<typeof PlurConfigSchema>
