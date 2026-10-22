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
    // The API @plur-ai/plur-enterprise builds on (no shebang: it is imported, not run).
    entry: ['src/enterprise-api.ts'],
    format: ['esm'],
    target: 'node22',
    dts: true,
    clean: false,
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
