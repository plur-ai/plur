import { existsSync } from 'fs'
import { join } from 'path'
import { loadEngrams } from './engrams.js'
import { embeddingContentHash, engramSearchText } from './fts.js'
import { mergeEmbeddingsIntoCache } from './embeddings.js'
import { getEmbedder, resolveEmbedderName } from './embedders/index.js'
import { logger } from './logger.js'

/**
 * #1046 migration: carry embedding vectors out of an orphaned PGLite store
 * into the JSON embeddings cache the yaml/sqlite tiers read.
 *
 * When the size ladder stopped selecting PGLite, the one asset a former
 * PGLite user could not get back for free was their vectors: the
 * `engram_embeddings` table was that tier's only vector storage, so after
 * the switch the embeddings cache is empty and the whole corpus re-embeds
 * in the background — minutes of CPU, with hybrid recall silently degraded
 * to BM25 until it finishes. This ports every vector that is still valid,
 * making the tier switch seamless.
 *
 * "Still valid" is checked twice, because the two stores key vectors
 * differently and neither key transfers:
 *
 *   - FRESHNESS: the PGLite row's `content_hash` (md5 of the engram's
 *     search text, `embeddingContentHash`) must match the md5 of the
 *     engram's CURRENT text in YAML. A vector computed from older text is
 *     skipped — porting it would silently poison ranking, and the
 *     background embed pass regenerates it anyway. Legacy rows with no
 *     content_hash (pre-#812) are skipped for the same reason: they cannot
 *     be verified.
 *   - DIMENSION: the vector's length must match the ACTIVE embedder's dim.
 *     A 768d bge-base store feeding a 384d bge-small cache would corrupt
 *     every similarity score; the cache's own meta header would reject the
 *     file wholesale, but checking per-vector gives an honest count
 *     instead.
 *
 * The JSON cache then re-keys accepted vectors under its own discipline
 * (sha256-16 of the search text) via `mergeEmbeddingsIntoCache` — the md5
 * never enters the cache.
 *
 * Read-only with respect to the PGLite store: nothing is deleted here.
 * Deleting `store.pglite/` afterwards is the user's call (doctor and the
 * CLI report both say so). Safe to re-run — existing cache entries win.
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
  /** Rows whose processing threw (undecodable vector, malformed row) — skipped, never fatal (#1063). */
  malformed: number
  error?: string
}

/** Coerce the three shapes a PGLite embedding column read can produce. Exported for tests (#1063). */
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
    // Float32Array over the ORIGINAL buffer throws RangeError when the
    // view's byteOffset is not 4-aligned (#1063 — unproven that a driver
    // ever hands one back, but a copy makes the question moot), and the
    // fresh allocation is always offset-0.
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
    // not exist` while the data sits intact under the file:// form (this
    // also explains the phantom-empty-store readings during the #1046
    // investigation). And without the vector extension, a table whose
    // column type is `vector(N)` cannot be read at all.
    const extensions: Record<string, unknown> = {}
    try {
      const vec = await import('@electric-sql/pglite/vector') as { vector: unknown }
      extensions.vector = vec.vector
    } catch { /* BYTEA-fallback stores have no vector column to need it */ }
    db = new (PGlite as unknown as new (dataDir: string, opts: { extensions: Record<string, unknown> }) => MinimalDb)(
      `file://${pglitePath}`, { extensions },
    )
    await (db as unknown as { waitReady: Promise<void> }).waitReady

    // Discover WHICH SCHEMA the table lives in rather than assuming public.
    // When the adapter ran with the AGE extension loaded, AGE prepends
    // ag_catalog to the search_path during its init, so every table the
    // adapter created landed in `ag_catalog` — invisible to a plain
    // search_path=public connection ("relation does not exist" on a store
    // that plainly holds the data; found the hard way writing this
    // migration). Stores built without AGE have it in public. Quoting via
    // format() is unnecessary: pg_tables.schemaname is trusted catalog
    // output, but quote_ident anyway since it is one function call.
    // ALL schemas holding the table, in a deterministic order (#1063): a
    // store that ran both with and without AGE over its lifetime has the
    // table in BOTH ag_catalog and public, and the previous unordered
    // `LIMIT 1` picked one arbitrarily — read the wrong (empty or stale)
    // copy and the export reports no-embeddings on a store that plainly
    // holds vectors. Reading every copy needs no tie-break at all: the
    // per-row freshness check below already decides which rows are valid,
    // whichever schema they came from.
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
      // Per-engram containment (#1063): one undecodable row must cost ONE
      // vector, not the whole export — the previous version let any throw in
      // here reach the outer catch, discarding every valid vector alongside
      // the bad one and silently costing the user the full re-embed this
      // module exists to avoid.
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
