import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { globals: true, exclude: ['**/openclaw-integration.test.mjs', '**/node_modules/**'] } })
