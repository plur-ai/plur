import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import {
  buildEngramSchema,
  buildPackManifestSchema,
  buildScopeMetadataSchema,
  serialize,
  ENGRAM_SCHEMA_PATH,
  PACK_SCHEMA_PATH,
  SCOPE_METADATA_SCHEMA_PATH,
} from '../scripts/gen-spec-schemas.js'

/**
 * Spec-drift guard — closes plur-ai/plur#315.
 *
 * The committed JSON Schemas in spec/ are generated from the Zod source of
 * truth (packages/core/src/schemas/*). This asserts they are in sync, so a
 * field added to Zod that isn't regenerated fails locally in `pnpm test`
 * (CI also runs `gen:schemas` + `git diff --exit-code spec/`).
 *
 * To fix a failure here: `pnpm --filter @plur-ai/core gen:schemas` and commit.
 */
describe('spec JSON Schema drift (#315)', () => {
  it('spec/engram.schema.json matches the generated output', () => {
    const committed = readFileSync(ENGRAM_SCHEMA_PATH, 'utf8')
    expect(serialize(buildEngramSchema())).toBe(committed)
  })

  it('spec/pack-manifest.schema.json matches the generated output', () => {
    const committed = readFileSync(PACK_SCHEMA_PATH, 'utf8')
    expect(serialize(buildPackManifestSchema())).toBe(committed)
  })

  it('spec/scope-metadata.schema.json matches the generated output', () => {
    const committed = readFileSync(SCOPE_METADATA_SCHEMA_PATH, 'utf8')
    expect(serialize(buildScopeMetadataSchema())).toBe(committed)
  })

  it('generation is deterministic (no runtime-dependent values leak in)', () => {
    // Second build equals first — guards against e.g. the activation
    // last_accessed `new Date()` default churning the file.
    expect(serialize(buildEngramSchema())).toBe(serialize(buildEngramSchema()))
  })

  it('preserves the documented divergences from a naive dump', () => {
    const engram = buildEngramSchema() as any
    // Open-world rule.
    expect(engram.additionalProperties).toBe(true)
    // Deterministic placeholder for the runtime default.
    expect(engram.properties.activation.default.last_accessed).toBe('')
    // #310 insight sub-object is captured automatically from Zod.
    expect(engram.properties.insight).toBeDefined()
    // Draft 2020-12 identity.
    expect(engram.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
  })
})
