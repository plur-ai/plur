/**
 * Reranker adapter interface — Sprint 0 cross-encoder reranker stage (#220).
 *
 * A reranker scores a `(query, document)` pair jointly in a single
 * transformer pass. Distinct from the bi-encoder embedders we ship:
 *   - Embedder: independently encodes query and document, cosine after.
 *     Can be pre-computed. Order: ~1ms/score after indexing.
 *   - Reranker: reads the pair together, emits a single relevance score.
 *     Cannot be pre-computed — runs on the top-K candidates only.
 *     Order: ~5-50ms per pair. Much more accurate.
 *
 * Wired in after BM25 + embedding RRF fusion in `hybridSearch`, reshuffles
 * the top K (default 50) by joint relevance before truncating to `limit`.
 *
 * Adapters are responsible for:
 *   - lazy model load on first score call
 *   - returning a numeric relevance score, higher = more relevant.
 *     Absolute scale is model-specific; only the ordering matters.
 *   - batching N pairs in scoreBatch where the model supports it
 *
 * Adapters must be stateless w.r.t. caller — repeated score(q, d) calls
 * produce identical output once the model is loaded.
 */
export interface RerankerAdapter {
  /** Short name used by getReranker() and PLUR_RERANKER. */
  readonly name: string
  /** Hugging Face model id (or local path) the adapter loads. */
  readonly modelId: string
  /** Score a single (query, document) pair. Higher = more relevant. */
  score(query: string, document: string): Promise<number>
  /**
   * Score multiple (query, document) pairs. Output order matches input
   * order. Default implementations iterate score(); cross-encoder adapters
   * should override for true batched inference.
   */
  scoreBatch(query: string, documents: string[]): Promise<number[]>
}
