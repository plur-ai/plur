/**
 * Integrity pins for every model PLUR can load (security audit 2026-11-06,
 * hardening H-x03-1).
 *
 * PLUR downloads its ONNX models from third-party Hugging Face repositories.
 * Without a pin, transformers.js fetches `resolve/main`, a moving branch: a
 * new commit to that repository (or anything that answers in its place) is
 * loaded on the next fresh download, and a cached file was reused without
 * any check at all. So each model is pinned here to an immutable commit, and
 * every file a load reads is checked against the sha256 recorded for it
 * before the model is used (see verifyPinnedModel in transformers-base.ts).
 *
 * `files` lists exactly the files transformers.js 4.2.0 reads for the dtype
 * PLUR loads each model with: the ONNX weights, their external-data chunks
 * (from the pinned config.json's `transformers.js_config`), config.json,
 * tokenizer.json and tokenizer_config.json. The feature-extraction and
 * sequence-classification heads of these architectures read no other file
 * (no generation_config.json: bert, xlm-roberta and gemma3_text-without-head
 * declare no optional configs in transformers.js' session_config.js).
 *
 * How the values were obtained, on 2026-11-07:
 *   - `revision`: the `sha` of
 *     `https://huggingface.co/api/models/<id>/revision/main`.
 *   - LFS files (all ONNX weights, and the two large tokenizer.json files):
 *     the `lfs.oid` (the file's sha256) listed by
 *     `https://huggingface.co/api/models/<id>/tree/<revision>?recursive=1`.
 *   - Non-LFS files (config.json, tokenizer_config.json and the small
 *     tokenizer.json files): sha256 of the bytes served by
 *     `https://huggingface.co/<id>/resolve/<revision>/<file>`, whose length
 *     was checked against the size in the same tree listing.
 *   - Xenova/bge-small-en-v1.5 was additionally downloaded through PLUR at
 *     this revision and every file re-hashed locally; the values matched.
 *
 * To move a model to a new commit: repeat the steps above for the new
 * revision and replace the whole entry. Never edit a hash by hand to make a
 * load pass.
 */

export interface ModelPin {
  /** The 40-hex commit sha transformers.js is asked for (`revision`). */
  readonly revision: string
  /** sha256 (64 hex) per file, keyed by its path in the repository. */
  readonly files: Readonly<Record<string, string>>
}

const TOKENIZER_CONFIG_BERT = '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3'
const TOKENIZER_JSON_BGE = 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66'

export const MODEL_PINS: Readonly<Record<string, ModelPin>> = Object.freeze({
  // bge-small (the default embedder), fp32.
  'Xenova/bge-small-en-v1.5': {
    revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    files: {
      'onnx/model.onnx': '828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35',
      'config.json': 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350',
      'tokenizer.json': TOKENIZER_JSON_BGE,
      'tokenizer_config.json': TOKENIZER_CONFIG_BERT,
    },
  },
  // bge-base, fp32.
  'Xenova/bge-base-en-v1.5': {
    revision: '4d6cd88e18e51a5e020c2c305726d76ada9c03cf',
    files: {
      'onnx/model.onnx': '9bc579acdba21c253c62a9bf866891355a63ffa3442b52c8a37d75b2ccb91848',
      'config.json': 'd83c21fa7366994560727112ef0a31d8a2ec1c280c2a3e66326fdb877f64c91e',
      'tokenizer.json': TOKENIZER_JSON_BGE,
      'tokenizer_config.json': TOKENIZER_CONFIG_BERT,
    },
  },
  // minilm, fp32.
  'Xenova/all-MiniLM-L6-v2': {
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    files: {
      'onnx/model.onnx': '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e',
      'config.json': '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
      'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
      'tokenizer_config.json': TOKENIZER_CONFIG_BERT,
    },
  },
  // embedding-gemma, q8; its config declares one external-data chunk for
  // model_quantized.onnx.
  'onnx-community/embeddinggemma-300m-ONNX': {
    revision: '5090578d9565bb06545b4552f76e6bc2c93e4a66',
    files: {
      'onnx/model_quantized.onnx': '172efde319fe1542dc41f31be6154910b05b78f7a861c265c4600eec906bd6d8',
      'onnx/model_quantized.onnx_data': '705626e28e4c23c82ade34566b4197d97f534c12275fa406dfb71e9937d388c0',
      'config.json': '6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b',
      'tokenizer.json': '4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47',
      'tokenizer_config.json': '3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a',
    },
  },
  // bge-reranker-v2-m3 reranker, q8 (no external data for the q8 file).
  'onnx-community/bge-reranker-v2-m3-ONNX': {
    revision: '6f5ff65298512715a1e669753bc754d2bc8f367b',
    files: {
      'onnx/model_quantized.onnx': '912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d',
      'config.json': '122e922dcfed6503c8721e6fe1daf090340c3d95ca7f3aa3a72730b321a51cfd',
      'tokenizer.json': '8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3',
      'tokenizer_config.json': 'b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80',
    },
  },
  // ms-marco-minilm-l6 reranker, q8.
  'Xenova/ms-marco-MiniLM-L-6-v2': {
    revision: 'a09144355adeed5f58c8ed011d209bf8ee5a1fec',
    files: {
      'onnx/model_quantized.onnx': 'e9d8ebf845c413e981c175bfe49a3bfa9b3dcce2a3ba54875ee5df5a58639fbe',
      'config.json': 'd827779a72d27ae68cf878a6fc2e954542663fe21ca515d9f4783fc96be2d37e',
      'tokenizer.json': TOKENIZER_JSON_BGE,
      'tokenizer_config.json': '0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53',
    },
  },
})

let pinOverrides: Record<string, ModelPin> | undefined

/** Test seam: pins for dummy model ids or dummy file contents (undefined restores). */
export function _setModelPinsForTesting(pins: Record<string, ModelPin> | undefined): void {
  pinOverrides = pins
}

/** The pin for `modelId`, or undefined when PLUR has none. */
export function modelPin(modelId: string): ModelPin | undefined {
  if (pinOverrides && Object.prototype.hasOwnProperty.call(pinOverrides, modelId)) return pinOverrides[modelId]
  return Object.prototype.hasOwnProperty.call(MODEL_PINS, modelId) ? MODEL_PINS[modelId] : undefined
}
