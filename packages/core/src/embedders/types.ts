/**
 * Embedder adapter interface — Sprint 0 PR 4 (feat/embedder-bake-off).
 *
 * Four candidate models live behind this shape so the benchmark harness can
 * swap them via --embedder and the PGLite vector column can be sized at
 * construction time based on `dim`.
 *
 * Adapters are responsible for:
 *   - lazy model load on first embed call
 *   - pooling + normalisation suitable for their family (CLS for BGE, mean
 *     for MiniLM, model-specific for EmbeddingGemma)
 *   - returning Float32Arrays of exactly `dim` floats
 *
 * Adapters must be stateless w.r.t. caller — repeated embed("foo") calls
 * produce identical output once the model is loaded.
 */
export interface EmbedderAdapter {
  /** Short name used by --embedder and PLUR_EMBEDDER. */
  readonly name: string
  /** Output dimensionality. Drives the PGLite vector(N) column type. */
  readonly dim: number
  /** Hugging Face model id (or local path) the adapter loads. */
  readonly modelId: string
  /** Embed a single text. Loads the model on first call. */
  embed(text: string): Promise<Float32Array>
  /** Embed N texts. Output order matches input order. */
  embedBatch(texts: string[]): Promise<Float32Array[]>
}
