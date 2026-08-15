import { defineConfig } from 'tsup'
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node22',
    dts: true,
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
    // Bundled, not depended on — see packages/ui/README.md.
    noExternal: ['@plur-ai/ui'],
  },
  {
    entry: ['src/commands/*.ts'],
    format: ['esm'],
    target: 'node22',
    dts: false,
    clean: false,
    outDir: 'dist/commands',
    noExternal: ['@plur-ai/ui'],
  },
])
