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
  ],
})
