/**
 * Reranker adapter interface: a cross-encoder scores a `(query, document)` pair jointly
 * (unlike bi-encoder embedders, it cannot be pre-computed — ~5-50ms per pair, more accurate).
 * Applied after RRF fusion in `hybridSearch` to the top K (default 50) before `limit`.
 * Adapters: load the model lazily, return higher = more relevant (only order matters),
 * batch in scoreBatch where supported, and be deterministic once loaded.
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
