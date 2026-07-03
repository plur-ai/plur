import { z } from 'zod'

/**
 * Tension record — the persisted output of a contradiction scan (#181).
 *
 * Phase 1 (#172) detection returned scan results to the caller and dropped
 * them: every scan re-paid the LLM calls, false positives were re-flagged
 * forever, and "resolved" had no representation (see the #213 audit,
 * findings C2/C5). A TensionRecord is the durable representation: one
 * record per engram pair, carried through the lifecycle
 *
 *   detected → confirmed → resolved   (real conflict, winner picked)
 *   detected → dismissed              (false positive, pair suppressed)
 *
 * Records live in `tensions.yaml` next to `engrams.yaml`. Any recorded
 * pair — whatever its status — is excluded from future scans, so
 * dismissals act as a suppress-list and detections are never re-judged.
 */
export const TensionStatusSchema = z.enum(['detected', 'confirmed', 'dismissed', 'resolved'])
export type TensionStatus = z.infer<typeof TensionStatusSchema>

/**
 * v1 category heuristic (deterministic, assigned at record time):
 * - `superseded`: a statement carries an explicit "(not X)" correction marker
 * - `temporal`: both engrams have derivable recorded dates ≥1 day apart —
 *   likely evolution of a changing situation rather than a wrong value
 * - `factual`: everything else (same-day or undatable pairs)
 *
 * Advisory only — resolution never branches on category; the user picks the
 * action. A judge-assisted categorization can replace this later without a
 * schema change.
 */
export const TensionCategorySchema = z.enum(['factual', 'temporal', 'superseded'])
export type TensionCategory = z.infer<typeof TensionCategorySchema>

export const TensionRecordSchema = z.object({
  /** T-YYYY-MMDD-NNN, numbered per detection day. */
  id: z.string(),
  engram_a: z.string(),
  engram_b: z.string(),
  /** Statement snapshots at detection time — engrams may be edited or retired later. */
  statement_a: z.string(),
  statement_b: z.string(),
  /** Judge confidence at detection. */
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  detected_at: z.string(),
  status: TensionStatusSchema.default('detected'),
  /** Winning engram id once resolved, else null. */
  resolved_by: z.string().nullable().default(null),
  resolved_at: z.string().nullable().default(null),
  category: TensionCategorySchema.default('factual'),
})

export type TensionRecord = z.infer<typeof TensionRecordSchema>
