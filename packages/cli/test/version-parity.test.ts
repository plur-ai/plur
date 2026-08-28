import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CLI_VERSION } from '../src/version.js'

/**
 * src/version.ts and package.json must agree — CLI_VERSION is what pins the
 * npx fallback MCP entries (#1069), and a stale pin would install an old
 * server. Same half-done-bump guard as dsh's manifest test: release.sh bumps
 * both; if it ever bumps only one, the suite fails instead of shipping.
 */
describe('CLI version parity', () => {
  it('src/version.ts matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
    expect(CLI_VERSION).toBe(pkg.version)
  })
})
