/**
 * Embedder dim mismatch detection — Sprint 0 PR 5 (#219).
 *
 * The configured embedder controls the dim of the PGLite `vector(N)` column.
 * If a user upgrades from a 384d embedder to a 768d one (or vice versa) and
 * never runs the migration, every recall returns BM25-only because the
 * pgvector ORDER BY throws a dim-mismatch error.
 *
 * `checkEmbedderDimMismatch()` opens the PGLite store read-only and reports
 * the discrepancy as a structured warning so callers (CLI `plur doctor`, MCP
 * session-start) can render it consistently and point at the fix command.
 *
 * Stateless and safe to call on every doctor run. The PGLite handle is
 * opened and closed within this function.
 */
import { existsSync } from 'fs'
import { PGLiteAdapter } from '../storage-pglite.js'

export interface DimMismatchWarning {
  indexedDim: number
  activeDim: number
  message: string
}

export interface DimCheckInputs {
  pglitePath: string
  yamlPath: string
  activeEmbedderDim: number
}

/**
 * Compare the indexed PGLite vector column dim against the active embedder's
 * dim. Returns a warning object when they differ; null otherwise. Never
 * throws — a missing or corrupt PGLite store returns null so the doctor
 * command can continue running its other checks.
 */
export async function checkEmbedderDimMismatch(inputs: DimCheckInputs): Promise<DimMismatchWarning | null> {
  if (!existsSync(inputs.pglitePath)) return null
  let adapter: PGLiteAdapter | null = null
  try {
    adapter = new PGLiteAdapter(inputs.yamlPath, inputs.pglitePath, { vectorDim: inputs.activeEmbedderDim })
    // Touch the DB once so the schema exists.
    await adapter.loadFiltered({})
    const indexedDim = await adapter.getVectorColumnDim()
    if (indexedDim === null) return null
    if (indexedDim === inputs.activeEmbedderDim) return null
    const message =
      `PGLite vector column is ${indexedDim}d but active embedder produces ${inputs.activeEmbedderDim}d vectors. ` +
      `Hybrid recall will fall back to BM25 until you run: plur sync --reembed --full`
    return { indexedDim, activeDim: inputs.activeEmbedderDim, message }
  } catch {
    return null
  } finally {
    if (adapter) {
      try { await adapter.close() } catch { /* ignore */ }
    }
  }
}
