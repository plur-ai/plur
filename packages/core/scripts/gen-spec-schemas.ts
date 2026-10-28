/**
 * Generate the Open Engram Standard JSON Schemas from the Zod source of truth
 * (#315). Closes the spec-drift gap: spec/engram.schema.json and
 * spec/pack-manifest.schema.json are emitted from packages/core/src/schemas/*,
 * so a field added to Zod can never silently go missing from the shipped spec.
 *
 *   pnpm --filter @plur-ai/core gen:schemas    # rewrite the spec/*.json files
 *
 * CI runs `gen:schemas` then `git diff --exit-code spec/` (see ci.yml), and
 * spec-schema-drift.test.ts asserts committed === generated in `pnpm test`.
 *
 * The build* functions are pure (Zod -> object); only main() touches disk, so
 * the drift test can import and compare without writing.
 *
 * Intentional, documented divergences from a naive z.toJSONSchema dump
 * (kept here, not in the Zod source, because they are spec policy not data shape):
 *   - root `additionalProperties: true` — the engram/manifest open-world rule
 *     (EngramSchemaPassthrough); unknown top-level fields are preserved, not rejected.
 *   - `activation.default.last_accessed` blanked to "" — the Zod default uses
 *     `new Date()` (a runtime value); baking today's date into the spec would make
 *     generation non-deterministic and churn the file daily.
 *   - $schema/$id/title/top-level description — spec identity, injected here.
 * Zod `.refine()` rules (DualCoding "at least one of", insight promote-requires-
 * grounding) are NOT representable in JSON Schema and are intentionally omitted;
 * they remain enforced at runtime by Zod.
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import { EngramSchema } from '../src/schemas/engram.js'
import { PackManifestSchema } from '../src/schemas/pack.js'
import { ScopeMetadataSchema } from '../src/schemas/scope-metadata.js'

const DRAFT = 'https://json-schema.org/draft/2020-12/schema'

// Repo root is three levels up from packages/core/scripts/.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
export const ENGRAM_SCHEMA_PATH = path.join(REPO_ROOT, 'spec', 'engram.schema.json')
export const PACK_SCHEMA_PATH = path.join(REPO_ROOT, 'spec', 'pack-manifest.schema.json')
export const SCOPE_METADATA_SCHEMA_PATH = path.join(REPO_ROOT, 'spec', 'scope-metadata.schema.json')

type JsonObject = Record<string, unknown>

/**
 * Bring zod 4's JSON Schema output to the shape the spec has always published
 * (it was generated with zod-to-json-schema under zod 3). Each rule is a
 * notation difference, not a change in what validates:
 *   - `.int()` emits the safe-integer range as minimum/maximum; JSON Schema
 *     integers carry no such bound in the published spec, so those two
 *     default bounds are dropped (an explicit `.min()`/`.max()` stays).
 *   - `z.record(z.string(), …)` emits `propertyNames: {type: string}`, which
 *     JSON object keys always satisfy.
 *   - In input mode a stripping object omits `additionalProperties`; the
 *     spec states `false` for closed objects. A `.passthrough()` object emits
 *     `{}`, written `true` as before. (A record's `additionalProperties` is
 *     its value schema and is left alone.)
 */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize)
  if (node === null || typeof node !== 'object') return node
  const out: JsonObject = {}
  // A name -> schema map: keep the names as they are, normalize each schema.
  const nameMap = (map: unknown) =>
    Object.fromEntries(Object.entries(map as JsonObject).map(([name, schema]) => [name, normalize(schema)]))
  for (const [key, value] of Object.entries(node as JsonObject)) {
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue
    if (key === 'minimum' && value === Number.MIN_SAFE_INTEGER) continue
    if (key === 'propertyNames' && JSON.stringify(value) === '{"type":"string"}') continue
    // `default` values are data, not schema: copy them as they are.
    out[key] = key === 'default' ? value
      : key === 'properties' || key === '$defs' ? nameMap(value)
      : normalize(value)
  }
  if (out.type === 'object' && out.properties) {
    if (!('additionalProperties' in out)) out.additionalProperties = false
    else if (JSON.stringify(out.additionalProperties) === '{}') out.additionalProperties = true
  }
  // Annotations after the keywords that constrain, as the spec has listed them.
  for (const key of ['default', 'description']) {
    if (key in out) { const v = out[key]; delete out[key]; out[key] = v }
  }
  return out
}

/** Run z.toJSONSchema with the standard options and apply the shared
 *  spec-header + open-world post-processing. */
function generate(schema: z.ZodType, identity: {
  $id: string; title: string; description: string
}): JsonObject {
  // Input mode: a field with a default is optional to a producer, as before.
  // `unrepresentable: 'any'` leaves out what JSON Schema cannot express
  // instead of throwing (refinements stay runtime-only; see the header comment).
  const raw = normalize(z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
    reused: 'inline',
  })) as JsonObject
  delete raw.$schema // re-added below, pinned to 2020-12

  // Open-world rule: the top-level object preserves unknown fields.
  raw.additionalProperties = true

  // Stable, readable key order with the spec identity first.
  return {
    $schema: DRAFT,
    $id: identity.$id,
    title: identity.title,
    description: identity.description,
    ...raw,
  }
}

export function buildEngramSchema(): JsonObject {
  const schema = generate(EngramSchema, {
    $id: 'https://plur.ai/spec/v1/engram.schema.json',
    title: 'Engram',
    description:
      'An engram is the atomic unit of learned knowledge in the Open Engram Standard v1. ' +
      'Generated from the Zod EngramSchema in @plur-ai/core (packages/core/src/schemas/engram.ts) ' +
      'by packages/core/scripts/gen-spec-schemas.ts — do not edit by hand. ' +
      'See ENGRAM-STANDARD-v1.md for normative semantics.',
  })

  // Blank the runtime `new Date()` default so generation is deterministic.
  const activation = (schema.properties as JsonObject | undefined)?.activation as JsonObject | undefined
  const actDefault = activation?.default as JsonObject | undefined
  if (actDefault && typeof actDefault.last_accessed === 'string') {
    actDefault.last_accessed = ''
  }
  return schema
}

export function buildPackManifestSchema(): JsonObject {
  return generate(PackManifestSchema, {
    $id: 'https://plur.ai/spec/v1/pack-manifest.schema.json',
    title: 'PackManifest',
    description:
      'Manifest for an engram pack in the Open Engram Standard v1. ' +
      'Generated from the Zod PackManifestSchema in @plur-ai/core (packages/core/src/schemas/pack.ts) ' +
      'by packages/core/scripts/gen-spec-schemas.ts — do not edit by hand. ' +
      'In on-disk packs this object is the YAML frontmatter of SKILL.md, or a standalone manifest.yaml. ' +
      'See ENGRAM-STANDARD-v1.md §5.',
  })
}

export function buildScopeMetadataSchema(): JsonObject {
  return generate(ScopeMetadataSchema, {
    $id: 'https://plur.ai/spec/v1/scope-metadata.schema.json',
    title: 'ScopeMetadata',
    description:
      'Self-describing metadata for an engram scope (Open Engram Standard, Stage 2, #345). ' +
      'Generated from the Zod ScopeMetadataSchema in @plur-ai/core (packages/core/src/schemas/scope-metadata.ts) ' +
      'by packages/core/scripts/gen-spec-schemas.ts — do not edit by hand. ' +
      'A scope with no metadata falls back to Stage 1 behavior (isSharedScope + detectSensitive).',
  })
}

/** Canonical serialization: 2-space indent, trailing newline. */
export function serialize(schema: JsonObject): string {
  return JSON.stringify(schema, null, 2) + '\n'
}

function main(): void {
  fs.writeFileSync(ENGRAM_SCHEMA_PATH, serialize(buildEngramSchema()))
  fs.writeFileSync(PACK_SCHEMA_PATH, serialize(buildPackManifestSchema()))
  fs.writeFileSync(SCOPE_METADATA_SCHEMA_PATH, serialize(buildScopeMetadataSchema()))
  console.log(
    `Wrote ${path.relative(REPO_ROOT, ENGRAM_SCHEMA_PATH)}, ` +
    `${path.relative(REPO_ROOT, PACK_SCHEMA_PATH)}, and ` +
    `${path.relative(REPO_ROOT, SCOPE_METADATA_SCHEMA_PATH)}`,
  )
}

// Only write when run as a CLI, not when imported by the drift test.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
