import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.ts', 'src/tools-export.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  // shebang is in src/index.ts, no banner needed
  // The provenance gateway client is bundled, not depended on — see packages/gateway/README.md.
  noExternal: ['@plur-ai/gateway'],
})
