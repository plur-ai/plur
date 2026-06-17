import { z } from 'zod'

export const PackManifestSchema = z.object({
  name: z.string()
    .describe('Human-readable pack name. Used as the registry key and capsule manifest_summary.name.'),
  version: z.string()
    .describe("Pack version. SemVer string recommended (e.g. '1.1.0'); validated as an opaque string, not range-checked."),
  description: z.string().optional(),
  creator: z.string().optional(),
  license: z.string().default('cc-by-sa-4.0')
    .describe('SPDX-style license identifier for the pack contents.'),
  tags: z.array(z.string()).default([]),
  metadata: z.object({
    id: z.string().optional().describe('Stable machine identifier for the pack.'),
    injection_policy: z.enum(['on_match', 'on_request', 'always']).default('on_match')
      .describe("When the loader is allowed to inject this pack's engrams."),
    match_terms: z.array(z.string()).default([]).describe('Keywords that gate on_match injection.'),
    domain: z.string().optional(),
    engram_count: z.number().optional()
      .describe('Declared number of engrams in the pack (advisory; loaders count the actual engrams.yaml).'),
  }).optional().describe('Loader metadata. Preferred forward-looking location for injection policy and matching terms.'),
  'x-datacore': z.object({
    id: z.string(),
    injection_policy: z.enum(['on_match', 'on_request']),
    match_terms: z.array(z.string()).default([]),
    domain: z.string().optional(),
    engram_count: z.number().int().min(0),
  }).optional().describe("LEGACY namespace, retained for backward compatibility with Datacore-era packs. New packs SHOULD use 'metadata'. Note: injection_policy here does NOT include 'always'."),
})

export type PackManifest = z.infer<typeof PackManifestSchema>
