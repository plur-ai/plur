import { z } from 'zod'

export const PackManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  creator: z.string().optional(),
  license: z.string().default('cc-by-sa-4.0'),
  tags: z.array(z.string()).default([]),
  metadata: z.object({
    id: z.string().optional(),
    injection_policy: z.enum(['on_match', 'on_request', 'always']).default('on_match'),
    match_terms: z.array(z.string()).default([]),
    domain: z.string().optional(),
    engram_count: z.number().optional(),
  }).optional(),
  'x-datacore': z.object({
    id: z.string(),
    injection_policy: z.enum(['on_match', 'on_request']),
    match_terms: z.array(z.string()).default([]),
    domain: z.string().optional(),
    engram_count: z.number().int().min(0),
  }).optional(),
})

export type PackManifest = z.infer<typeof PackManifestSchema>
