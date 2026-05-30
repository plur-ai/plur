/**
 * Embedder dim mismatch detection — Sprint 0 PR 5 (#219), extended in iter-2
 * audit B-3.
 *
 * The configured embedder controls the dim of the PGLite `vector(N)` column
 * AND the JSON `.embeddings-cache.json` entries. If a user upgrades from a
 * 384d embedder to a 768d one (or vice versa) and never runs the migration:
 *
 *   - PGLite path: pgvector ORDER BY throws a dim-mismatch error.
 *   - JSON cache path: cosineSimilarity iterates min(a, b) and silently
 *     returns garbage scores.
 *
 * `checkEmbedderDimMismatch()` checks both paths and reports the worst
 * discrepancy as a structured warning so callers (CLI `plur doctor`, MCP
 * session-start) can render it consistently and point at the fix command.
 *
 * Stateless and safe to call on every doctor run.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { PGLiteAdapter } from '../storage-pglite.js'

export interface DimMismatchWarning {
  indexedDim: number
  activeDim: number
  /** Where the mismatch was detected. */
  source: 'pglite' | 'json-cache'
  message: string
}

export interface DimCheckInputs {
  pglitePath: string
  yamlPath: string
  activeEmbedderDim: number
  /** Path to the JSON embeddings cache (default: `<root>/.embeddings-cache.json`). */
  jsonCachePath?: string
  /** Active embedder name for cache-header comparison (B-3 — same-dim, different-family case). */
  activeEmbedderName?: string
}

/**
 * Compare the indexed PGLite vector column dim against the active embedder's
 * dim. Returns a warning object when they differ; null otherwise. Never
 * throws — a missing or corrupt PGLite store returns null so the doctor
 * command can continue running its other checks.
 *
 * When `jsonCachePath` is provided AND `pglitePath` is not active, falls
 * back to the JSON-cache check (closes RC-3 for default users).
 */
export async function checkEmbedderDimMismatch(inputs: DimCheckInputs): Promise<DimMismatchWarning | null> {
  // PGLite path first — it's the wired-in production index.
  if (existsSync(inputs.pglitePath)) {
    let adapter: PGLiteAdapter | null = null
    try {
      adapter = new PGLiteAdapter(inputs.yamlPath, inputs.pglitePath, { vectorDim: inputs.activeEmbedderDim })
      // Touch the DB once so the schema exists.
      await adapter.loadFiltered({})
      const indexedDim = await adapter.getVectorColumnDim()
      if (indexedDim !== null && indexedDim !== inputs.activeEmbedderDim) {
        const message =
          `PGLite vector column is ${indexedDim}d but active embedder produces ${inputs.activeEmbedderDim}d vectors. ` +
          `Hybrid recall will fall back to BM25 until you run: plur sync --reembed --full`
        return { indexedDim, activeDim: inputs.activeEmbedderDim, source: 'pglite', message }
      }
    } catch {
      // ignore — continue to JSON cache check
    } finally {
      if (adapter) {
        try { await adapter.close() } catch { /* ignore */ }
      }
    }
  }

  // JSON cache path — for default (non-PGLite) installs (iter-2 audit B-3).
  const cachePath = inputs.jsonCachePath
  if (cachePath && existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
      // Legacy flat-object format counts as a hard mismatch — recommend
      // the migration so the user moves to the stamped format.
      if (raw && typeof raw === 'object' && !raw.meta) {
        const message =
          `Embeddings cache is in legacy format (no embedder identity). ` +
          `Run: plur sync --reembed --full to rebuild against the active embedder ` +
          `(${inputs.activeEmbedderDim}d).`
        return {
          indexedDim: 0,
          activeDim: inputs.activeEmbedderDim,
          source: 'json-cache',
          message,
        }
      }
      const meta = raw?.meta as { embedder_dim?: number; embedder_name?: string } | undefined
      if (meta && typeof meta.embedder_dim === 'number') {
        const dimMismatch = meta.embedder_dim !== inputs.activeEmbedderDim
        const nameMismatch =
          inputs.activeEmbedderName !== undefined &&
          typeof meta.embedder_name === 'string' &&
          meta.embedder_name !== inputs.activeEmbedderName
        if (dimMismatch || nameMismatch) {
          const message =
            `Embeddings cache is ${meta.embedder_dim}d (${meta.embedder_name ?? 'unknown embedder'}) ` +
            `but active embedder produces ${inputs.activeEmbedderDim}d vectors` +
            (inputs.activeEmbedderName ? ` (${inputs.activeEmbedderName})` : '') +
            `. Run: plur sync --reembed --full to rebuild the cache.`
          return {
            indexedDim: meta.embedder_dim,
            activeDim: inputs.activeEmbedderDim,
            source: 'json-cache',
            message,
          }
        }
      }
    } catch {
      // Unreadable JSON cache — let the rebuild path repair it on the next recall.
    }
  }

  return null
}

/**
 * Helper that callers can use to derive the default JSON cache path.
 * Mirrors the path used by `embeddings.ts`.
 */
export function defaultJsonCachePath(storageRoot: string): string {
  return join(storageRoot, '.embeddings-cache.json')
}
