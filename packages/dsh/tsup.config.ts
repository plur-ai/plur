import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  // The viewer is bundled in, not depended on. It is the pages behind
  // /plur-memory, not a library anyone installs — shipping it as its own npm
  // package would add a name, a version track and a publish ordering
  // constraint for ~45KB that only first-party code consumes.
  noExternal: ['@plur-ai/ui'],
})
