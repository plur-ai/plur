import { z } from 'zod'

export const StoreEntrySchema = z.object({
  path: z.string(),
  scope: z.string(),
  shared: z.boolean().default(false),
  readonly: z.boolean().default(false),
})

export type StoreEntry = z.infer<typeof StoreEntrySchema>

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
  allow_secrets: z.boolean().default(false),
  index: z.boolean().default(true),
  stores: z.array(StoreEntrySchema).default([]),
}).partial()

export type PlurConfig = z.infer<typeof PlurConfigSchema>
