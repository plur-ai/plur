import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries: the root is pure render functions a browser bundler can take,
  // `server` is the Node-only HTTP host. Keeping node:http out of the root is
  // the whole reason for the split.
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
})
