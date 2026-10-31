import { existsSync } from 'fs'
import { join } from 'path'
import { loadEngrams } from './engrams.js'
import { embeddingContentHash, engramSearchText } from './fts.js'
import { mergeEmbeddingsIntoCache } from './embeddings.js'
import { getEmbedder, resolveEmbedderName } from './embedders/index.js'
import { logger } from './logger.js'

/**
 * Carry embedding vectors out of an orphaned PGLite store into the JSON
 * embeddings cache the yaml/sqlite tiers read, so leaving that tier does not
 * force a full re-embed. A vector is ported only if:
 *   - FRESHNESS: its `content_hash` matches the md5 of the engram's CURRENT
 *     search text (`embeddingContentHash`); stale or unhashed rows are skipped.
 *   - DIMENSION: its length matches the ACTIVE embedder's dimension.
 * The cache re-keys accepted vectors itself (`mergeEmbeddingsIntoCache`).
 * Read-only on PGLite (deleting `store.pglite/` is the user's call); re-runnable.
 */

export interface PgliteEmbeddingsExportReport {
  status: 'no-store' | 'no-embeddings' | 'done' | 'failed'
  /** Vectors written into the cache. */
  ported: number
  /** Rows skipped because the engram's text changed since the vector was computed (or the row predates content hashes). */
  stale: number
  /** Rows skipped because their dimension does not match the active embedder. */
  wrongDim: number
  /** Rows whose engram no longer exists in YAML. */
  orphaned: number
  /** Rows whose processing threw (undecodable vector, malformed row) — skipped, never fatal. */
  malformed: number
  error?: string
}

/** Coerce the three shapes a PGLite embedding column read can produce. Exported for tests. */
export function toNumberArray(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    return value.every(n => typeof n === 'number' && Number.isFinite(n)) ? value as number[] : null
  }
  if (typeof value === 'string') {
    // pgvector's wire format: "[0.1,0.2,...]"
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) && parsed.every(n => typeof n === 'number' && Number.isFinite(n))
        ? parsed as number[]
        : null
    } catch {
      return null
    }
  }
  if (value instanceof Uint8Array) {
    // BYTEA fallback: little-endian float32s. Copy before viewing: a
    // Float32Array over the original buffer throws RangeError when the
    // view's byteOffset is not 4-aligned, and a fresh allocation is always
    // offset-0.
    if (value.byteLength % 4 !== 0) return null
    // The copy constructor, NOT .slice(): Buffer overrides slice with no-copy
    // semantics, and even Uint8Array.prototype.slice species-creates a Buffer
    // here — which can come from Node's pool with a nonzero byteOffset, so a
    // Float32Array over `.buffer` at offset 0 would read pool garbage.
    // `new Uint8Array(view)` always allocates a fresh offset-0 ArrayBuffer.
    const copy = new Uint8Array(value)
    return Array.from(new Float32Array(copy.buffer))
  }
  return null
}

export async function exportPgliteEmbeddingsToCache(
  storageRoot: string,
  engramsPath: string = join(storageRoot, 'engrams.yaml'),
  pglitePath: string = join(storageRoot, 'store.pglite'),
): Promise<PgliteEmbeddingsExportReport> {
  const report: PgliteEmbeddingsExportReport = { status: 'done', ported: 0, stale: 0, wrongDim: 0, orphaned: 0, malformed: 0 }

  if (!existsSync(pglitePath)) return { ...report, status: 'no-store' }

  // Metadata-only: the embedder factory resolves name+dim without loading
  // the model (same call the Plur constructor makes).
  const active = getEmbedder(resolveEmbedderName())

  interface MinimalDb {
    query: (q: string) => Promise<{ rows: Array<Record<string, unknown>> }>
    close: () => Promise<void>
  }
  let db: MinimalDb | null = null
  try {
    const { PGlite } = await import('@electric-sql/pglite')
    // Open EXACTLY the way PGLiteAdapter does: the `file://` prefix and the
    // vector extension. A bare path resolves to a DIFFERENT data directory
    // in this PGlite version — an adapter-written store read back with
    // `PGlite.create(barePath)` reports `relation "engram_embeddings" does
    // not exist` while the data sits intact under the file:// form. Without
    // the vector extension, a `vector(N)` column cannot be read at all.
    const extensions: Record<string, unknown> = {}
    try {
      const vec = await import('@electric-sql/pglite/vector') as { vector: unknown }
      extensions.vector = vec.vector
    } catch { /* BYTEA-fallback stores have no vector column to need it */ }
    db = new (PGlite as unknown as new (dataDir: string, opts: { extensions: Record<string, unknown> }) => MinimalDb)(
      `file://${pglitePath}`, { extensions },
    )
    await (db as unknown as { waitReady: Promise<void> }).waitReady

    // Discover WHICH SCHEMA the table lives in: with the AGE extension loaded,
    // tables land in `ag_catalog`, otherwise in public. Read ALL schemas
    // holding it, deterministically ordered; the per-row freshness check below
    // decides which rows are valid. quote_ident is applied anyway.
    const loc = await db.query(
      "SELECT quote_ident(schemaname) AS s FROM pg_tables WHERE tablename = 'engram_embeddings' ORDER BY schemaname",
    )
    if (loc.rows.length === 0) return { ...report, status: 'no-embeddings' }

    const byId = new Map<string, Array<{ embedding: unknown; content_hash: unknown }>>()
    let totalRows = 0
    for (const schemaRow of loc.rows) {
      const schema = String(schemaRow.s)
      const res = await db.query(`SELECT engram_id, embedding, content_hash FROM ${schema}.engram_embeddings`)
      totalRows += res.rows.length
      for (const r of res.rows) {
        const id = String(r.engram_id)
        const rows = byId.get(id) ?? []
        rows.push({ embedding: r.embedding, content_hash: r.content_hash })
        byId.set(id, rows)
      }
    }
    if (totalRows === 0) return { ...report, status: 'no-embeddings' }

    const engrams = loadEngrams(engramsPath)
    const present = new Set<string>()
    const imports: Array<{ engramId: string; searchText: string; embedding: number[] }> = []

    for (const engram of engrams) {
      const rows = byId.get(engram.id)
      if (!rows) continue
      present.add(engram.id)
      // Per-engram containment: one undecodable row must cost ONE vector, not
      // the whole export (a throw reaching the outer catch would discard
      // every valid vector and force the full re-embed this module avoids).
      try {
        const currentHash = embeddingContentHash(engram)
        const fresh = rows.find(r => typeof r.content_hash === 'string' && r.content_hash === currentHash)
        if (!fresh) {
          report.stale++
          continue
        }
        const vec = toNumberArray(fresh.embedding)
        if (!vec || vec.length !== active.dim) {
          report.wrongDim++
          continue
        }
        imports.push({ engramId: engram.id, searchText: engramSearchText(engram), embedding: vec })
      } catch {
        report.malformed++
      }
    }
    report.orphaned = byId.size - present.size

    report.ported = mergeEmbeddingsIntoCache(storageRoot, { name: active.name, dim: active.dim }, imports)
    return report
  } catch (err: unknown) {
    logger.warning(`[plur] PGLite embeddings export failed: ${(err as Error)?.message ?? 'unknown error'}`)
    return { ...report, status: 'failed', error: (err as Error)?.message ?? 'unknown error' }
  } finally {
    await db?.close().catch(() => { /* export already done or failed; a close error changes nothing */ })
  }
}
