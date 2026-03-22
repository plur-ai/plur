import type { Engram } from './schemas/engram.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Embedding-based semantic search for engrams.
 *
 * Uses @huggingface/transformers (ONNX runtime) for local embeddings.
 * Model: all-MiniLM-L6-v2 (~80MB, 384-dim, fast on CPU)
 *
 * Embeddings are cached per-engram using content hashing to avoid
 * re-computation on subsequent searches.
 */

// Lazy-loaded pipeline — only initialized when first needed
let embedPipeline: any = null

async function getEmbedder() {
  if (!embedPipeline) {
    const { pipeline } = await import('@huggingface/transformers')
    embedPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'fp32',
    })
  }
  return embedPipeline
}

/** Generate embedding for a text string. Returns Float32Array of 384 dims. */
async function embed(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder()
  const result = await embedder(text, { pooling: 'mean', normalize: true })
  return new Float32Array(result.data)
}

/** Cosine similarity between two vectors. */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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
  writeFileSync(cachePath, JSON.stringify(cache))
}

function hashStatement(statement: string): string {
  // Simple hash — good enough for cache invalidation
  let hash = 0
  for (let i = 0; i < statement.length; i++) {
    hash = ((hash << 5) - hash + statement.charCodeAt(i)) | 0
  }
  return hash.toString(36)
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

  // Embed engrams (with caching)
  const similarities: Array<{ engram: Engram; score: number }> = []

  for (const engram of engrams) {
    const hash = hashStatement(engram.statement)
    let engramEmbedding: Float32Array

    if (cache[engram.id]?.hash === hash) {
      // Cache hit
      engramEmbedding = new Float32Array(cache[engram.id].embedding)
    } else {
      // Cache miss — compute embedding
      engramEmbedding = await embed(engram.statement)
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
