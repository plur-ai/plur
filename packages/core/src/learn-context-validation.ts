import { z } from 'zod'
import { EngramSchema, EngramSchemaPassthrough, KnowledgeTypeSchema, ProvenanceSchema } from './schemas/engram.js'
import { LEARN_CONTEXT_FIELD_ROLES } from './content-fields.js'
import type { LearnContext } from './types.js'

// Direct fields reuse their persisted representation. These aliases are the
// only exceptions; adding a new context field requires an explicit schema.
const aliases = {
  memory_class: KnowledgeTypeSchema.shape.memory_class,
  license: ProvenanceSchema.shape.license,
  valid_from: z.string(),
  valid_until: z.string(),
  supersedes: z.array(z.string()),
  session: z.string(),
  session_episode_id: z.string(),
} satisfies Record<Exclude<keyof LearnContext, keyof typeof EngramSchema.shape>, z.ZodTypeAny>

const shape = Object.fromEntries(Object.keys(LEARN_CONTEXT_FIELD_ROLES).map(key => {
  const schema = (EngramSchema.shape as Record<string, z.ZodTypeAny>)[key]
    ?? (aliases as Record<string, z.ZodTypeAny>)[key]
  if (!schema) throw new Error(`Missing learn-context schema: ${key}`)
  return [key, schema.optional()]
}))
const contextSchema = z.object(shape)

export function validateLearnContext(context: unknown): void {
  if (context === undefined) return
  const result = contextSchema.safeParse(context)
  if (!result.success) {
    // Field names identify the problem without echoing sensitive input values.
    throw new TypeError(`Invalid learn context: invalid ${result.error.issues[0]?.path.join('.') || 'object'}`)
  }
}

/** Validate replacement records without adding defaults or stripping fields. */
export function validateEngramWrite(engram: unknown): void {
  const result = EngramSchemaPassthrough.safeParse(engram)
  if (!result.success) throw new TypeError(`Invalid engram write: ${result.error.issues[0]?.path.join('.') || 'object'}`)
}
