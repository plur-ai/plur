import type { Engram } from './schemas/engram.js'
import { engramSearchText } from './fts.js'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { atomicWrite } from './sync.js'

/**
 * Embedding-based semantic search for engrams.
 *
 * Uses @huggingface/transformers (ONNX runtime) for local embeddings.
 * Model: BAAI/bge-small-en-v1.5 (~130MB, 384-dim, strong MTEB, fast)
 *
 * BGE models significantly outperform MiniLM on MTEB retrieval benchmarks
 * while keeping the same 384-dim footprint. bge-small-en-v1.5 scores ~62 on
 * MTEB vs ~42 for all-MiniLM-L6-v2.
 *
 * Embeddings are cached per-engram using content hashing to avoid
 * re-computation on subsequent searches.
 */

// Lazy-loaded pipeline — only initialized when first needed
let embedPipeline: any = null
let transformersUnavailable = false

async function getEmbedder() {
  if (transformersUnavailable) return null
  if (!embedPipeline) {
    try {
      const { pipeline } = await import('@huggingface/transformers')
      embedPipeline = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
        dtype: 'fp32',
      })
    } catch {
      transformersUnavailable = true
      return null
    }
  }
  return embedPipeline
}

/** Generate embedding for a text string. Returns Float32Array of 384 dims, or null if unavailable. */
export async function embed(text: string): Promise<Float32Array | null> {
  const embedder = await getEmbedder()
  if (!embedder) return null
  const result = await embedder(text, { pooling: 'cls', normalize: true })
  return new Float32Array(result.data)
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // vectors are already normalized, so dot product = cosine similarity
}

/** Cache file for embeddings. */
interface EmbeddingCache {
  [engramId: string]: {
    hash: string
    embedding: number[]
  }
}

function loadCache(cachePath: string): EmbeddingCache {
  if (!existsSync(cachePath)) return {}
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8'))
  } catch {
    return {}
  }
}

function saveCache(cachePath: string, cache: EmbeddingCache): void {
  const dir = cachePath.substring(0, cachePath.lastIndexOf('/'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  atomicWrite(cachePath, JSON.stringify(cache))
}

function hashStatement(statement: string): string {
  return createHash('sha256').update(statement).digest('hex').slice(0, 16)
}

/**
 * Semantic search using embeddings.
 * Computes embedding for query, compares against cached engram embeddings.
 * Returns engrams sorted by cosine similarity (descending).
 */
export async function embeddingSearch(
  engrams: Engram[],
  query: string,
  limit: number,
  storagePath?: string,
): Promise<Engram[]> {
  if (engrams.length === 0) return []

  // Load embedding cache
  const cachePath = storagePath
    ? join(storagePath, '.embeddings-cache.json')
    : '.embeddings-cache.json'
  const cache = loadCache(cachePath)

  // Embed the query
  const queryEmbedding = await embed(query)
  if (!queryEmbedding) {
    // Embeddings unavailable — return empty (caller should fall back to BM25)
    return []
  }

  // Embed engrams (with caching)
  const similarities: Array<{ engram: Engram; score: number }> = []

  for (const engram of engrams) {
    const searchText = engramSearchText(engram)
    const hash = hashStatement(searchText)
    let engramEmbedding: Float32Array

    if (cache[engram.id]?.hash === hash) {
      // Cache hit
      engramEmbedding = new Float32Array(cache[engram.id].embedding)
    } else {
      // Cache miss — compute embedding from enriched text
      const emb = await embed(searchText)
      if (!emb) return [] // model unloaded mid-search
      engramEmbedding = emb
      cache[engram.id] = {
        hash,
        embedding: Array.from(engramEmbedding),
      }
    }

    const score = cosineSimilarity(queryEmbedding, engramEmbedding)
    similarities.push({ engram, score })
  }

  // Save updated cache
  saveCache(cachePath, cache)

  // Sort by similarity (descending) and return top N
  similarities.sort((a, b) => b.score - a.score)
  return similarities.slice(0, limit).map(s => s.engram)
}

/** Result with cosine similarity score attached. */
export interface SimilarityResult {
  engram: Engram
  score: number
}

/**
 * Semantic search using embeddings, returning scored results.
 * Identical to embeddingSearch but preserves cosine similarity scores.
 */
export async function embeddingSearchWithScores(
  engrams: Engram[],
  query: string,
  limit: number,
  storagePath?: string,
): Promise<SimilarityResult[]> {
  if (engrams.length === 0) return []

  // Load embedding cache
  const cachePath = storagePath
    ? join(storagePath, '.embeddings-cache.json')
    : '.embeddings-cache.json'
  const cache = loadCache(cachePath)

  // Embed the query
  const queryEmbedding = await embed(query)
  if (!queryEmbedding) {
    // Embeddings unavailable — return empty (caller should fall back to BM25)
    return []
  }

  // Embed engrams (with caching)
  const similarities: SimilarityResult[] = []

  for (const engram of engrams) {
    const searchText = engramSearchText(engram)
    const hash = hashStatement(searchText)
    let engramEmbedding: Float32Array

    if (cache[engram.id]?.hash === hash) {
      // Cache hit
      engramEmbedding = new Float32Array(cache[engram.id].embedding)
    } else {
      // Cache miss — compute embedding from enriched text
      const emb = await embed(searchText)
      if (!emb) return [] // model unloaded mid-search
      engramEmbedding = emb
      cache[engram.id] = {
        hash,
        embedding: Array.from(engramEmbedding),
      }
    }

    const score = cosineSimilarity(queryEmbedding, engramEmbedding)
    similarities.push({ engram, score })
  }

  // Save updated cache
  saveCache(cachePath, cache)

  // Sort by similarity (descending) and return top N with scores
  similarities.sort((a, b) => b.score - a.score)
  return similarities.slice(0, limit)
}
