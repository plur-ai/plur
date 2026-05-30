import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  // Keep optional native + transformers deps external so Node's resolver picks
  // the correct binding (onnxruntime-node) at runtime. Bundling them breaks
  // backend registration ("listSupportedBackends is not a function").
  external: [
    '@huggingface/transformers',
    'onnxruntime-node',
    'onnxruntime-web',
    'onnxruntime-common',
    'sharp',
    '@huggingface/jinja',
    // PGLite ships pre-bundled WASM + extension .tar.gz files alongside its
    // ESM entry point. Bundling it copies the .js chunks into core's dist
    // but leaves the extension archives behind, which then fail at runtime
    // ("Extension bundle not found: vector.tar.gz"). Keep external so
    // Node's resolver locates the full PGLite tree under node_modules.
    '@electric-sql/pglite',
    '@electric-sql/pglite/vector',
    '@electric-sql/pglite/age',
  ],
})
