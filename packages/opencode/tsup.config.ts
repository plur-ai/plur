import { defineConfig } from 'tsup'
export default defineConfig({
  // `setup.ts` is a second, deliberately separate entry (not re-exported
  // from index.ts): it has zero dependencies on @plur-ai/core or
  // @opencode-ai/plugin, and `plur init --opencode` (packages/cli) imports
  // it via the `@plur-ai/opencode/setup` subpath so pulling in the config
  // writer never drags the plugin runtime (Plur, BlockCache, TurnBuffer)
  // into the CLI's bundle.
  entry: ['src/index.ts', 'src/setup.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
})
