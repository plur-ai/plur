import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAW_VERSION } from '../src/version.js'

/**
 * src/version.ts and package.json must agree — CLAW_VERSION is what the
 * plugin object, the engine info and the heartbeat payload report, so a
 * missed bump would ship a plugin that mis-identifies itself while the
 * suite stays green. Same guard pattern as mcp/cli/dsh.
 */
describe('claw version parity', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }

  it('src/version.ts matches package.json', () => {
    expect(CLAW_VERSION).toBe(pkg.version)
  })

  it('index.ts and context-engine.ts import the constant rather than repeating it', () => {
    for (const f of ['index.ts', 'context-engine.ts']) {
      const src = readFileSync(join(__dirname, '..', 'src', f), 'utf8')
      expect(src, f).toContain("from './version.js'")
      expect(src, f).not.toMatch(/version: '\d+\.\d+\.\d+'/)
    }
  })
})
